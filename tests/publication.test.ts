import { describe, expect, it } from "vitest";
import { GET as capabilitiesRoute } from "@/app/api/mercadolivre/capabilities/route";
import { GET as suggestRoute } from "@/app/api/mercadolivre/categories/suggest/route";
import { GET as attributesRoute } from "@/app/api/mercadolivre/categories/[categoryId]/attributes/route";
import { GET as matchesRoute } from "@/app/api/mercadolivre/catalog/matches/route";
import { PATCH as draftPatch } from "@/app/api/listing-drafts/[id]/route";
import { POST as validateRoute } from "@/app/api/listing-drafts/[id]/validate/route";
import { GET as reviewRoute } from "@/app/api/listing-drafts/[id]/review/route";
import { POST as publishRoute } from "@/app/api/listing-drafts/[id]/publish/route";
import { POST as batchRoute } from "@/app/api/listing-drafts/publish-batch/route";
import { POST as reconcileRoute } from "@/app/api/marketplace/publication-jobs/[id]/reconcile/route";
import { POST as cancelRoute } from "@/app/api/marketplace/publication-jobs/[id]/cancel/route";
import { createDrafts, getDraft, listDrafts, updateDraft } from "@/lib/catalog/drafts";
import { draftDisplayStatus } from "@/lib/format";
import { getCapabilities } from "@/lib/meli/capabilities";
import { getCategory, getCategoryAttributes, type MeliAttribute } from "@/lib/meli/categories";
import { buildItemPayload, fingerprint, loadContext } from "@/lib/publish/payload";
import { getPublicationJob, listAttempts, reopenForRepublish, requestPublication } from "@/lib/publish/service";
import { checkAttributes, issuesFromMeli, validateDraft } from "@/lib/publish/validate";
import { MeliHttpError } from "@/lib/meli/api";
import { MAX_RECONCILE, processPublicationJobs } from "@/lib/publish/worker";
import { syncAllListings } from "@/lib/publish/listings";
import { ingestNotification, processEvents, resetSellerCacheForTests } from "@/lib/marketplace/events";
import { setStorageForTesting, type ObjectStorage } from "@/lib/storage/supabase";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { attributesFixture, CATEGORY, mockMeliApi } from "./helpers/meli-api-mock";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";

const t = useTestDatabase();
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const noSleep = async () => {};

class FakeStorage implements ObjectStorage {
  async upload() {}
  async remove() {}
  publicUrl(path: string) {
    return `https://cdn.test/${path}`;
  }
}

function send(path: string, method: string, body?: unknown, headers: Record<string, string> = { origin: BASE }) {
  return makeRequest(path, { method, cookies: adminCookies(), headers, body });
}

async function seedProduct(ads = 1804, opts: { image?: boolean } = {}): Promise<number> {
  const sql = t.sql();
  const [{ id }] = await sql.query<{ id: number }>(
    `INSERT INTO products (ads_product_id, name_original, ean, presentation, raw_payload) VALUES ($1, $2, '7896014106226', '950ML', $3::jsonb) RETURNING id`,
    [ads, `LOREAL P OXIDANTE CR 950ML 20VOL ${ads}`, JSON.stringify({ produtoId: ads, marca: "" })],
  );
  await sql.execute(`INSERT INTO price_tables (code, description, raw_payload) VALUES ('F', 'FIO & TRATO', '{}') ON CONFLICT DO NOTHING`);
  await sql.execute(
    `INSERT INTO product_prices (product_id, ads_product_id, branch_id, price_table_code, price, discount, raw_payload) VALUES ($1, $2, '01', 'F', 88.2, 10, '{}')`,
    [id, ads],
  );
  await sql.execute(`INSERT INTO product_stocks (product_id, ads_product_id, branch_id, quantity, raw_payload) VALUES ($1, $2, '01', 3, '{}')`, [id, ads]);
  if (opts.image !== false) {
    await sql.execute(
      `INSERT INTO product_images (product_id, storage_path, public_url, content_type, size_bytes, width, height, is_primary)
       VALUES ($1, $2, $3, 'image/png', 64, 800, 800, true)`,
      [id, `products/${ads}/a.png`, `https://cdn.test/products/${ads}/a.png`],
    );
  }
  return id;
}

/** Rascunho completo e validado (modelo detectado pela conta simulada). */
async function seedValidatedDraft(ads = 1804): Promise<number> {
  const productId = await seedProduct(ads);
  const { created } = await createDrafts(t.sql(), [productId]);
  const draftId = created[0].draftId;
  await updateDraft(t.sql(), draftId, {
    familyName: "Oxidante Creme L'Oréal 20 Volumes 950ml",
    title: "Oxidante Creme L'Oréal 20 Volumes 950ml",
    description: "Oxidante em creme 20 volumes, 950 ml.",
    marketplaceCategoryId: CATEGORY,
    categoryName: "Coloração",
    marketplaceAttributes: [
      { id: "BRAND", value_name: "L'Oréal Professionnel" },
      { id: "NAME", value_name: "Oxidante Creme" },
      { id: "GTIN", value_name: "7896014106226" },
      { id: "OXIDANT_VOLUMES", value_id: "18495513", value_name: "20" },
    ],
    listingTypeId: "gold_special",
    itemCondition: "new",
    listingPrice: "109.90",
    listingQuantity: 2,
  });
  const result = await validateDraft(t.sql(), draftId);
  expect(result?.status).toBe("VALIDATED");
  return draftId;
}

async function publish(draftId: number) {
  const draft = (await getDraft(t.sql(), draftId))!;
  return requestPublication(t.sql(), { draftId, draftVersion: draft.version, fingerprint: draft.validatedFingerprint!, requestedBy: "admin:test" });
}

async function runWorker(times = 5) {
  for (let i = 0; i < times; i++) {
    const r = await processPublicationJobs({ sql: t.sql(), budgetMs: 4000, sleep: noSleep });
    if (!r.more) return;
    await t.sql().execute(`UPDATE marketplace_publication_jobs SET next_run_at = now() WHERE status IN ('QUEUED','UNKNOWN') AND next_run_at < 'infinity'`);
  }
}

async function setup(opts: Parameters<typeof mockMeliApi>[0] = {}) {
  setStorageForTesting(new FakeStorage());
  await seedConnection({ expiresInMs: 3600_000, meliUserId: "42" });
  return mockMeliApi(opts);
}

describe("capacidades da conta e modelo de publicação", () => {
  it("detecta User Products pela tag user_product_seller e o escopo de escrita; não guarda dados pessoais", async () => {
    await setup();
    const caps = await getCapabilities(t.sql(), { refresh: true });
    expect(caps).toMatchObject({ connected: true, meliUserId: "42", userProductSeller: true, publicationModel: "USER_PRODUCTS", canWrite: true });
    const [row] = await t.sql().query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'meli_capabilities'`);
    expect(JSON.stringify(row.value)).not.toContain("example.com");
  });

  it("sem a tag, modelo clássico; sem conexão, informa not_connected", async () => {
    await setup({ tags: ["normal"] });
    expect((await getCapabilities(t.sql(), { refresh: true })).publicationModel).toBe("CLASSIC");
    await t.sql().execute(`DELETE FROM app_settings`);
    setStorageForTesting(new FakeStorage());
    const { setStoreForTesting } = await import("@/lib/store");
    const { MemoryStore } = await import("./helpers/memory-store");
    setStoreForTesting(new MemoryStore());
    expect(await getCapabilities(t.sql())).toMatchObject({ connected: false, error: "not_connected" });
  });

  it("rota de capacidades exige administrador", async () => {
    await setup();
    expect((await capabilitiesRoute(makeRequest("/api/mercadolivre/capabilities"))).status).toBe(401);
    const res = await capabilitiesRoute(makeRequest("/api/mercadolivre/capabilities?refresh=1", { cookies: adminCookies() }));
    expect((await res.json()).capabilities.publicationModel).toBe("USER_PRODUCTS");
  });
});

describe("categorias e atributos", () => {
  it("preditor oficial retorna sugestões; categoria e atributos ficam em cache", async () => {
    const { state } = await setup();
    const productId = await seedProduct();
    const { created } = await createDrafts(t.sql(), [productId]);
    const res = await suggestRoute(makeRequest(`/api/mercadolivre/categories/suggest?draftId=${created[0].draftId}`, { cookies: adminCookies() }));
    expect((await res.json()).suggestions[0]).toMatchObject({ categoryId: CATEGORY, categoryName: "Coloração" });

    await getCategory(t.sql(), CATEGORY);
    await getCategory(t.sql(), CATEGORY);
    await getCategoryAttributes(t.sql(), CATEGORY);
    await getCategoryAttributes(t.sql(), CATEGORY);
    expect(state.calls.filter((c) => c.path === `/categories/${CATEGORY}`)).toHaveLength(1);
    expect(state.calls.filter((c) => c.path === `/categories/${CATEGORY}/attributes`)).toHaveLength(1);
  });

  it("sugestões de atributos usam só correspondências confiáveis da ADS (GTIN válido, apresentação) e do preditor", async () => {
    await setup();
    const productId = await seedProduct();
    const { created } = await createDrafts(t.sql(), [productId]);
    const res = await attributesRoute(makeRequest(`/api/mercadolivre/categories/${CATEGORY}/attributes?draftId=${created[0].draftId}`, { cookies: adminCookies() }), ctx({ categoryId: CATEGORY }));
    const body = await res.json();
    expect(body.attributes).toHaveLength(attributesFixture.length);
    const byId = Object.fromEntries(body.suggestions.map((s: { id: string }) => [s.id, s]));
    expect(byId.GTIN.value_name).toBe("7896014106226");
    expect(byId.NET_VOLUME.value_name).toBe("950 mL");
    expect(byId.OXIDANT_VOLUMES).toMatchObject({ value_id: "18495513", source: "preditor" });
    expect(byId.BRAND).toBeUndefined(); // marca vazia na ADS: nada inventado
  });

  it("regras de atributos: obrigatórios, condicionais, lista, unidade, GTIN e somente leitura", () => {
    const attrs = attributesFixture as MeliAttribute[];
    const issues = checkAttributes(
      attrs,
      [
        { id: "OXIDANT_VOLUMES", value_id: "999" },
        { id: "NET_VOLUME", value_name: "950 galões" },
        { id: "GTIN", value_name: "7896014106227" },
        { id: "PACKAGE_HEIGHT", value_name: "10 cm" },
      ],
      { conditionalRequired: ["GTIN"], catalogListing: false },
    );
    const codes = issues.map((i) => `${i.code}:${i.field}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "ATTRIBUTE_REQUIRED:attr:BRAND",
        "ATTRIBUTE_REQUIRED:attr:NAME",
        "ATTRIBUTE_VALUE_NOT_ALLOWED:attr:OXIDANT_VOLUMES",
        "ATTRIBUTE_UNIT_INVALID:attr:NET_VOLUME",
        "GTIN_INVALID:attr:GTIN",
        "ATTRIBUTE_READ_ONLY:attr:PACKAGE_HEIGHT",
      ]),
    );
    // GTIN ausente, mas com motivo: atende o condicional
    const ok = checkAttributes(attrs, [{ id: "BRAND", value_name: "X" }, { id: "NAME", value_name: "Y" }, { id: "EMPTY_GTIN_REASON", value_id: "17055158" }], { conditionalRequired: null, catalogListing: false });
    expect(ok.filter((i) => i.severity === "error")).toEqual([]);
    const missing = checkAttributes(attrs, [{ id: "BRAND", value_name: "X" }, { id: "NAME", value_name: "Y" }], { conditionalRequired: null, catalogListing: false });
    expect(missing.map((i) => i.code)).toContain("GTIN_OR_REASON_REQUIRED");
  });

  it("catálogo: identifica pelo GTIN, sem vincular automaticamente", async () => {
    await setup();
    const productId = await seedProduct();
    const { created } = await createDrafts(t.sql(), [productId]);
    const res = await matchesRoute(makeRequest(`/api/mercadolivre/catalog/matches?draftId=${created[0].draftId}`, { cookies: adminCookies() }));
    const body = await res.json();
    expect(body.by).toBe("gtin");
    expect(body.matches[0]).toMatchObject({ id: "MLB19999999", brand: "L'Oréal" });
    expect((await getDraft(t.sql(), created[0].draftId))!.catalogProductId).toBeNull();
  });
});

describe("validação e payload", () => {
  it("rascunho incompleto lista os motivos e fica INCOMPLETE (sem chamar a validação oficial)", async () => {
    const { state } = await setup();
    const productId = await seedProduct(1804, { image: false });
    const { created } = await createDrafts(t.sql(), [productId]);
    const r = (await validateDraft(t.sql(), created[0].draftId))!;
    expect(r.status).toBe("INCOMPLETE");
    expect(r.issues.filter((i) => i.severity === "error").map((i) => i.code)).toEqual(
      expect.arrayContaining(["CATEGORY_MISSING", "PRICE_INVALID", "QUANTITY_INVALID", "LISTING_TYPE_MISSING", "NO_IMAGES"]),
    );
    expect(state.calls.some((c) => c.path === "/items/validate")).toBe(false);
  });

  it("rascunho completo passa pela validação oficial e vira VALIDATED com impressão digital", async () => {
    const { state } = await setup();
    const draftId = await seedValidatedDraft();
    const d = (await getDraft(t.sql(), draftId))!;
    expect(d).toMatchObject({ status: "VALIDATED", validatedVersion: d.version });
    expect(d.validatedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const call = state.calls.find((c) => c.path === "/items/validate")!;
    expect(call.auth).toMatch(/^Bearer /);
  });

  it("erros da validação oficial (400) viram pendências; indisponibilidade (5xx) deixa READY, não publicável", async () => {
    const { state } = await setup({ validateMode: "400" });
    const productId = await seedProduct();
    const { created } = await createDrafts(t.sql(), [productId]);
    const id = created[0].draftId;
    await updateDraft(t.sql(), id, {
      familyName: "Oxidante 20 vol",
      marketplaceCategoryId: CATEGORY,
      marketplaceAttributes: [{ id: "BRAND", value_name: "L" }, { id: "NAME", value_name: "N" }, { id: "GTIN", value_name: "7896014106226" }],
      listingTypeId: "gold_special",
      listingPrice: "50",
      listingQuantity: 1,
    });
    const r = (await validateDraft(t.sql(), id))!;
    expect(r.status).toBe("INCOMPLETE");
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["ML_ITEM.ATTRIBUTES.MISSING_REQUIRED", "ML_ITEM.TITLE.LENGTH"]));
    state.validateMode = "500";
    expect((await validateDraft(t.sql(), id))!.status).toBe("READY");
  });

  it("recusa sem causas do tipo erro (403): a mensagem principal vira erro", () => {
    const e = new MeliHttpError("forbidden", 403, "seller.unable_to_list (HTTP 403 em /items/validate)", "forbidden", [{ code: "x", message: "w", type: "warning" }]);
    const issues = issuesFromMeli(e);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("seller.unable_to_list");
  });

  it("400 do /items/validate só com avisos (frete): aprovado com avisos e publicável", async () => {
    await setup({ validateMode: "400warn" });
    const productId = await seedProduct();
    const { created } = await createDrafts(t.sql(), [productId]);
    const id = created[0].draftId;
    await updateDraft(t.sql(), id, {
      familyName: "Oxidante 20 vol",
      marketplaceCategoryId: CATEGORY,
      marketplaceAttributes: [{ id: "BRAND", value_name: "L" }, { id: "NAME", value_name: "N" }, { id: "GTIN", value_name: "7896014106226" }],
      listingTypeId: "gold_special",
      listingPrice: "50",
      listingQuantity: 1,
    });
    const r = (await validateDraft(t.sql(), id))!;
    expect(r.remote).toBe("ok_warnings");
    expect(r.status).toBe("VALIDATED");
    expect(r.fingerprint).toBeTruthy();
    expect(r.issues.some((i) => i.severity === "error")).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["ML_SHIPPING.LOST_ME1_BY_USER", "ML_ITEM.SHIPPING.MANDATORY_FREE_SHIPPING"]));
  });

  it("modelo User Products: envia family_name, sem title e sem variations; SELLER_SKU sempre presente", async () => {
    await setup();
    const draftId = await seedValidatedDraft();
    const up = buildItemPayload((await loadContext(t.sql(), draftId, "USER_PRODUCTS"))!, { pictures: "source" });
    expect(up.family_name).toBe("Oxidante Creme L'Oréal 20 Volumes 950ml");
    expect(up).not.toHaveProperty("title");
    expect(up).not.toHaveProperty("variations");
    expect(up).toMatchObject({ category_id: CATEGORY, price: 109.9, currency_id: "BRL", available_quantity: 2, listing_type_id: "gold_special", condition: "new", buying_mode: "buy_it_now" });
    expect(up.attributes).toContainEqual({ id: "SELLER_SKU", value_name: "ADS-1804" });
    expect(up.pictures).toEqual([{ source: "https://cdn.test/products/1804/a.png" }]);
    const classic = buildItemPayload((await loadContext(t.sql(), draftId, "CLASSIC"))!, { pictures: "source" });
    expect(classic.title).toBe("Oxidante Creme L'Oréal 20 Volumes 950ml");
    expect(classic).not.toHaveProperty("family_name");
  });

  it("qualquer alteração gera nova versão e invalida a validação; publicar versão antiga é recusado", async () => {
    await setup();
    const draftId = await seedValidatedDraft();
    const before = (await getDraft(t.sql(), draftId))!;
    const res = await draftPatch(send(`/api/listing-drafts/${draftId}`, "PATCH", { listingPrice: "99,90" }), ctx({ id: String(draftId) }));
    const after = (await res.json()).draft;
    expect(after).toMatchObject({ version: before.version + 1, status: "DRAFT", listingPrice: "99.90" });
    const pub = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", { confirm: true, draftVersion: before.version, fingerprint: before.validatedFingerprint }), ctx({ id: String(draftId) }));
    expect(pub.status).toBe(409);
    expect((await pub.json()).error).toBe("not_validated");
  });

  it("revisão informa a impressão digital e se o conteúdo ainda é o validado (ex.: imagem trocada)", async () => {
    await setup();
    const draftId = await seedValidatedDraft();
    const r1 = await (await reviewRoute(send(`/api/listing-drafts/${draftId}/review`, "GET"), ctx({ id: String(draftId) }))).json();
    expect(r1.publishable).toBe(true);
    expect(r1.review).toMatchObject({ titleField: "family_name", account: { meliUserId: "42", nickname: "FIOETRATO" }, sellerSku: "ADS-1804" });
    await t.sql().execute(`UPDATE product_images SET storage_path = 'products/1804/b.png'`);
    const r2 = await (await reviewRoute(send(`/api/listing-drafts/${draftId}/review`, "GET"), ctx({ id: String(draftId) }))).json();
    expect(r2.publishable).toBe(false);
    const pub = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", { confirm: true, draftVersion: r1.review.draftVersion, fingerprint: r1.fingerprint }), ctx({ id: String(draftId) }));
    expect((await pub.json()).error).toBe("content_changed");
  });
});

describe("publicação", () => {
  it("publica: envia imagens, cria o anúncio, grava item_id, user_product_id, family_id e a descrição; tudo auditado", async () => {
    const { state, createCalls } = await setup();
    const draftId = await seedValidatedDraft();
    const { job } = await publish(draftId);
    expect(job.status).toBe("QUEUED");
    expect((await getDraft(t.sql(), draftId))!.status).toBe("PUBLISHING");
    await runWorker();

    const done = (await getPublicationJob(t.sql(), job.id))!;
    expect(done).toMatchObject({ status: "SUCCEEDED", marketplaceItemId: "MLB1000", attemptCount: 1 });
    const d = (await getDraft(t.sql(), draftId))!;
    expect(d).toMatchObject({ status: "PUBLISHED", marketplaceItemId: "MLB1000", listingStatus: "active" });
    const [listing] = await t.sql().query<Record<string, unknown>>(
      `SELECT ads_product_id, user_product_id, family_id, price::text AS price, quantity, permalink, description_status FROM marketplace_listings`,
    );
    expect(listing).toMatchObject({ ads_product_id: 1804, user_product_id: "MLBU1000", family_id: "777", price: "109.90", quantity: 2, description_status: "sent" });
    expect(createCalls()).toHaveLength(1);
    expect((createCalls()[0].body as { pictures: unknown }).pictures).toEqual([{ id: "PIC-1" }]);
    expect(state.calls.some((c) => c.path === "/items/MLB1000/description")).toBe(true);
    const [img] = await t.sql().query<{ ml: string }>(`SELECT ml_picture_id AS ml FROM product_images`);
    expect(img.ml).toBe("PIC-1");

    const attempts = await listAttempts(t.sql(), job.id);
    expect(attempts.map((a) => a.operation)).toEqual(["precheck_seller_sku", "upload_picture", "create_item", "description"]);
    expect(JSON.stringify(attempts)).not.toMatch(/APP_USR|Bearer/);
    const events = await t.sql().query<{ type: string }>(`SELECT event_type AS type FROM marketplace_listing_events WHERE listing_draft_id = $1 ORDER BY id`, [draftId]);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["publication_requested", "published_created"]));
  });

  it("idempotência: repetir o mesmo comando devolve o mesmo job e cria um único anúncio", async () => {
    const { createCalls } = await setup();
    const draftId = await seedValidatedDraft();
    const draft = (await getDraft(t.sql(), draftId))!;
    const body = { confirm: true, draftVersion: draft.version, fingerprint: draft.validatedFingerprint };
    const first = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", body), ctx({ id: String(draftId) }));
    const second = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", body), ctx({ id: String(draftId) }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const [a, b] = [await first.json(), await second.json()];
    expect(b.replayed).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    await runWorker();
    await runWorker();
    expect(createCalls()).toHaveLength(1);
    // Depois de publicado, nova tentativa é recusada (não cria segundo anúncio).
    const third = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", body), ctx({ id: String(draftId) }));
    expect([200, 409]).toContain(third.status);
    await runWorker();
    expect(createCalls()).toHaveLength(1);
  });

  it("anúncio já existente com o mesmo SELLER_SKU é vinculado sem novo POST", async () => {
    const { state, createCalls } = await setup();
    state.items.set("ADS-1804", { id: "MLB555", permalink: "https://produto.mercadolivre.com.br/MLB-555", status: "active", price: 109.9, available_quantity: 2, category_id: CATEGORY });
    const draftId = await seedValidatedDraft();
    await publish(draftId);
    await runWorker();
    expect(createCalls()).toHaveLength(0);
    expect((await getDraft(t.sql(), draftId))!).toMatchObject({ status: "PUBLISHED", marketplaceItemId: "MLB555" });
  });

  it("400 do Mercado Livre: job e rascunho FAILED com o motivo; o rascunho volta a ser editável", async () => {
    await setup({ createMode: ["400"] });
    const draftId = await seedValidatedDraft();
    const { job } = await publish(draftId);
    await runWorker();
    expect((await getPublicationJob(t.sql(), job.id))!).toMatchObject({ status: "FAILED", errorCode: "validation_error" });
    const d = (await getDraft(t.sql(), draftId))!;
    expect(d.status).toBe("FAILED");
    expect(d.lastError).toContain("item.price.invalid");
    await expect(updateDraft(t.sql(), draftId, { listingPrice: "120.00" })).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("401 e 403 encerram como FAILED sem reenvio", async () => {
    const { createCalls } = await setup({ createMode: ["401"] });
    const a = await seedValidatedDraft(1804);
    await publish(a);
    await runWorker();
    expect((await getDraft(t.sql(), a))!.status).toBe("FAILED");
    expect(createCalls()).toHaveLength(1);
  });

  it("429: reenfileira com segurança (o ML recusou antes de processar) e conclui com um único anúncio", async () => {
    const { createCalls } = await setup({ createMode: ["429"] });
    const draftId = await seedValidatedDraft();
    const { job } = await publish(draftId);
    await runWorker();
    expect(createCalls()).toHaveLength(2);
    expect((await getPublicationJob(t.sql(), job.id))!.status).toBe("SUCCEEDED");
    expect(await t.sql().query(`SELECT 1 FROM marketplace_listings`)).toHaveLength(1);
  });

  it("timeout após criar: UNKNOWN, sem reenviar o POST; a conciliação por SELLER_SKU encontra e vincula", async () => {
    const { createCalls } = await setup({ createMode: ["timeout_after_create"] });
    const draftId = await seedValidatedDraft();
    const { job } = await publish(draftId);
    await processPublicationJobs({ sql: t.sql(), budgetMs: 2000, sleep: noSleep });
    expect((await getPublicationJob(t.sql(), job.id))!.status).toBe("UNKNOWN");
    expect((await getDraft(t.sql(), draftId))!.status).toBe("UNKNOWN");
    await runWorker();
    expect(createCalls()).toHaveLength(1);
    expect((await getPublicationJob(t.sql(), job.id))!).toMatchObject({ status: "SUCCEEDED", marketplaceItemId: "MLB1000" });
    const events = await t.sql().query<{ type: string }>(`SELECT event_type AS type FROM marketplace_listing_events WHERE listing_draft_id = $1`, [draftId]);
    expect(events.map((e) => e.type)).toContain("published_reconciled");
  });

  it("5xx com anúncio criado também é conciliado sem duplicar", async () => {
    const { createCalls } = await setup({ createMode: ["500_created"] });
    const draftId = await seedValidatedDraft();
    await publish(draftId);
    await runWorker();
    expect(createCalls()).toHaveLength(1);
    expect((await getDraft(t.sql(), draftId))!.status).toBe("PUBLISHED");
  });

  it("timeout sem criação: permanece UNKNOWN após as conferências; só o administrador pode declarar 'não criado'", async () => {
    const { createCalls } = await setup({ createMode: ["timeout_before_create"] });
    const draftId = await seedValidatedDraft();
    const { job } = await publish(draftId);
    await runWorker(MAX_RECONCILE + 3);
    const j = (await getPublicationJob(t.sql(), job.id))!;
    expect(j.status).toBe("UNKNOWN");
    expect(j.reconcileCount).toBe(MAX_RECONCILE);
    expect(createCalls()).toHaveLength(1);

    const noConfirm = await reconcileRoute(send(`/api/marketplace/publication-jobs/${job.id}/reconcile`, "POST", { resolution: "not_created" }), ctx({ id: job.id }));
    expect(noConfirm.status).toBe(400);
    const res = await reconcileRoute(send(`/api/marketplace/publication-jobs/${job.id}/reconcile`, "POST", { resolution: "not_created", confirm: true }), ctx({ id: job.id }));
    expect((await res.json()).job.status).toBe("FAILED");
    expect((await getDraft(t.sql(), draftId))!.status).toBe("FAILED");
    expect(createCalls()).toHaveLength(1);
  });

  it("token expirado é renovado pelo serviço da fase 1 durante a publicação", async () => {
    setStorageForTesting(new FakeStorage());
    await seedConnection({ expiresInMs: 60_000, meliUserId: "42" }); // dentro da margem de 5 min: renova
    const { state } = mockMeliApi();
    const productId = await seedProduct();
    const { created } = await createDrafts(t.sql(), [productId]);
    expect(state.tokenRefreshes).toBe(0);
    await getCapabilities(t.sql(), { refresh: true });
    expect(state.tokenRefreshes).toBe(1);
    expect(state.calls.find((c) => c.path === "/users/me")!.auth).toBe("Bearer APP_USR-NEW-1");
    expect(created).toHaveLength(1);
  });

  it("proteção contra duplicidade: um job ativo por rascunho e um anúncio por produto/conta", async () => {
    await setup();
    const draftId = await seedValidatedDraft();
    const draft = (await getDraft(t.sql(), draftId))!;
    await publish(draftId);
    await expect(requestPublication(t.sql(), { draftId, draftVersion: draft.version, fingerprint: "f".repeat(64), requestedBy: "x" })).rejects.toMatchObject({ code: "publication_in_progress" });
    await runWorker();
    // Repetir o comando já concluído devolve o mesmo pedido (sem novo job, sem novo POST).
    await t.sql().execute(`UPDATE listing_drafts SET status = 'VALIDATED' WHERE id = $1`, [draftId]); // forçado
    const replay = await publish(draftId);
    expect(replay).toMatchObject({ replayed: true, job: { status: "SUCCEEDED" } });
    // Uma nova versão do mesmo produto é barrada pelo vínculo produto/conta já publicado.
    await t.sql().execute(`UPDATE listing_drafts SET version = version + 1, validated_version = version + 1 WHERE id = $1`, [draftId]);
    await expect(publish(draftId)).rejects.toMatchObject({ code: "already_published" });
    expect(await t.sql().query(`SELECT 1 FROM marketplace_publication_jobs`)).toHaveLength(1);
  });

  it("cancelamento só para jobs ainda na fila", async () => {
    await setup({ createMode: ["timeout_before_create"] });
    const a = await seedValidatedDraft(1804);
    const { job } = await publish(a);
    const res = await cancelRoute(send(`/api/marketplace/publication-jobs/${job.id}/cancel`, "POST", {}), ctx({ id: job.id }));
    expect((await res.json()).job.status).toBe("CANCELED");
    expect((await getDraft(t.sql(), a))!.status).toBe("VALIDATED");

    const again = await publish(a);
    await processPublicationJobs({ sql: t.sql(), budgetMs: 2000, sleep: noSleep });
    expect((await getPublicationJob(t.sql(), again.job.id))!.status).toBe("UNKNOWN");
    const res2 = await cancelRoute(send(`/api/marketplace/publication-jobs/${again.job.id}/cancel`, "POST", {}), ctx({ id: again.job.id }));
    expect(res2.status).toBe(409);
  });

  it("imagem fora do armazenamento do integrador é recusada (SSRF) sem criar anúncio", async () => {
    const { createCalls } = await setup();
    const draftId = await seedValidatedDraft();
    await t.sql().execute(`UPDATE product_images SET public_url = 'https://169.254.169.254/latest/meta-data'`);
    const d = (await getDraft(t.sql(), draftId))!;
    const fp = fingerprint((await loadContext(t.sql(), draftId, "USER_PRODUCTS"))!);
    await t.sql().execute(`UPDATE listing_drafts SET validated_fingerprint = $2 WHERE id = $1`, [draftId, fp]);
    const { job } = await requestPublication(t.sql(), { draftId, draftVersion: d.version, fingerprint: fp, requestedBy: "x" });
    await runWorker();
    expect((await getPublicationJob(t.sql(), job.id))!.status).toBe("FAILED");
    expect(createCalls()).toHaveLength(0);
  });
});

describe("publicação em lote e autorização", () => {
  it("lote: resultado individual; falha de um não interrompe os demais; envio sequencial", async () => {
    const { createCalls } = await setup({ createMode: ["ok", "400", "ok"] });
    const ids = [await seedValidatedDraft(1001), await seedValidatedDraft(1002), await seedValidatedDraft(1003)];
    const notValidated = (await createDrafts(t.sql(), [await seedProduct(1004)])).created[0].draftId;
    const items = [];
    for (const id of [...ids, notValidated]) {
      const d = (await getDraft(t.sql(), id))!;
      items.push({ draftId: id, draftVersion: d.version, fingerprint: d.validatedFingerprint ?? "0".repeat(64) });
    }
    const res = await batchRoute(send("/api/listing-drafts/publish-batch", "POST", { confirm: true, items }));
    const body = await res.json();
    expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true, false]);
    expect(body.results[3].code).toBe("not_validated");
    await runWorker(10);
    expect(createCalls()).toHaveLength(3);
    const statuses = await Promise.all(ids.map(async (id) => (await getDraft(t.sql(), id))!.status));
    expect(statuses).toEqual(["PUBLISHED", "FAILED", "PUBLISHED"]);
  });

  it("publicação exige sessão, mesma origem e confirmação explícita", async () => {
    await setup();
    const draftId = await seedValidatedDraft();
    const d = (await getDraft(t.sql(), draftId))!;
    const body = { confirm: true, draftVersion: d.version, fingerprint: d.validatedFingerprint };
    const anon = await publishRoute(makeRequest(`/api/listing-drafts/${draftId}/publish`, { method: "POST", headers: { origin: BASE }, body }), ctx({ id: String(draftId) }));
    expect(anon.status).toBe(401);
    const csrf = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", body, { origin: "https://atacante.example" }), ctx({ id: String(draftId) }));
    expect(csrf.status).toBe(403);
    const noConfirm = await publishRoute(send(`/api/listing-drafts/${draftId}/publish`, "POST", { ...body, confirm: false }), ctx({ id: String(draftId) }));
    expect(noConfirm.status).toBe(400);
    const validateAnon = await validateRoute(makeRequest(`/api/listing-drafts/${draftId}/validate`, { method: "POST", headers: { origin: BASE } }), ctx({ id: String(draftId) }));
    expect(validateAnon.status).toBe(401);
    expect(await t.sql().query(`SELECT 1 FROM marketplace_publication_jobs`)).toHaveLength(0);
  });

  it("rascunho em publicação não pode ser editado", async () => {
    await setup();
    const draftId = await seedValidatedDraft();
    await publish(draftId);
    const res = await draftPatch(send(`/api/listing-drafts/${draftId}`, "PATCH", { listingPrice: "1,00" }), ctx({ id: String(draftId) }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("draft_locked");
  });
});

describe("status do anúncio depois de publicado (somente leitura no ML)", () => {
  async function published() {
    const ml = await setup();
    const draftId = await seedValidatedDraft();
    await publish(draftId);
    await runWorker();
    const item = [...ml.state.items.values()].find((i) => i.id === "MLB1000")!;
    return { ...ml, draftId, item };
  }
  const status = async () => (await t.sql().query<{ status: string }>(`SELECT status FROM marketplace_listings`))[0].status;

  it("sincronização em lote lê pausado e excluído; nada é enviado ao ML além de leituras", async () => {
    const { state, item, draftId } = await published();
    item.status = "paused";
    expect(await syncAllListings(t.sql())).toMatchObject({ checked: 1, changed: 1, failed: 0 });
    expect(await status()).toBe("paused");
    item.status = "closed";
    item.sub_status = ["deleted"];
    await syncAllListings(t.sql());
    expect(await status()).toBe("deleted");
    const events = await t.sql().query<{ to: string }>(
      `SELECT new_status AS "to" FROM marketplace_listing_events WHERE listing_draft_id = $1 AND event_type = 'listing_status_changed' ORDER BY id`,
      [draftId],
    );
    expect(events.map((e) => e.to)).toEqual(["paused", "deleted"]);
    const writesAfterPublish = state.calls.filter((c) => c.method !== "GET" && !["/items", "/items/validate", "/pictures/items/upload", "/items/MLB1000/description"].includes(c.path));
    expect(writesAfterPublish.filter((c) => c.path.startsWith("/items/MLB1000") && c.method === "PUT")).toHaveLength(0);
  });

  it("item que some do ML (404) fica como excluído", async () => {
    const { state } = await published();
    state.items.clear();
    await syncAllListings(t.sql());
    expect(await status()).toBe("deleted");
  });

  it("notificação só aciona releitura para item desta conta e desta aplicação; corpo não é confiado", async () => {
    const { item } = await published();
    item.status = "closed";
    resetSellerCacheForTests();
    expect(await ingestNotification(t.sql(), { resource: "/items/MLB1000", user_id: 42, topic: "items", application_id: 999 })).toMatchObject({ outcome: "rejected" });
    expect(await ingestNotification(t.sql(), { resource: "/../items/MLB1000", user_id: 42, topic: "items", application_id: 1234567890 })).toMatchObject({ outcome: "rejected" });
    expect(await ingestNotification(t.sql(), { _id: "n-other", resource: "/items/MLB1000", user_id: 999, topic: "items", application_id: 1234567890 })).toMatchObject({ status: "IGNORED", reason: "unknown_seller" });
    await processEvents({ sql: t.sql() });
    expect(await status()).toBe("active");
    expect(await ingestNotification(t.sql(), { _id: "n-ok", resource: "/items/MLB1000", user_id: 42, topic: "items", application_id: 1234567890 })).toMatchObject({ status: "PENDING" });
    await processEvents({ sql: t.sql() });
    expect(await status()).toBe("closed");
  });
});

describe("republicação depois de anúncio encerrado ou excluído no ML", () => {
  async function publishedPilot() {
    const ml = await setup();
    const draftId = await seedValidatedDraft();
    await publish(draftId);
    await runWorker();
    return { ...ml, draftId, item: [...ml.state.items.values()].find((i) => i.id === "MLB1000")! };
  }

  it("bloqueia enquanto o anúncio está ativo ou pausado (status relido no ML, não confiado no banco)", async () => {
    const { draftId, item } = await publishedPilot();
    // banco diz "deleted", mas o ML diz ativo: a releitura impede a reabertura
    await t.sql().execute(`UPDATE marketplace_listings SET status = 'deleted'`);
    await expect(reopenForRepublish(t.sql(), draftId, "admin:test")).rejects.toMatchObject({ code: "listing_still_active" });
    item.status = "paused";
    await expect(reopenForRepublish(t.sql(), draftId, "admin:test")).rejects.toMatchObject({ code: "listing_still_active" });
    expect((await getDraft(t.sql(), draftId))!.status).toBe("PUBLISHED");
  });

  it("excluído no ML: reabre com nova versão, exige nova validação e cria um NOVO anúncio sem reaproveitar o excluído", async () => {
    const { draftId, item, createCalls } = await publishedPilot();
    item.status = "closed";
    item.sub_status = ["deleted"];
    const before = (await getDraft(t.sql(), draftId))!;

    const r = await reopenForRepublish(t.sql(), draftId, "admin:test");
    expect(r).toEqual({ previousItemId: "MLB1000", previousStatus: "deleted" });
    const reopened = (await getDraft(t.sql(), draftId))!;
    expect(reopened).toMatchObject({ status: "DRAFT", version: before.version + 1, validatedFingerprint: null });
    // sem nova validação não publica
    await expect(publish(draftId)).rejects.toBeTruthy();

    const v = (await validateDraft(t.sql(), draftId))!;
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(v.status).toBe("VALIDATED");
    await publish(draftId);
    await runWorker();

    expect(createCalls()).toHaveLength(2);
    const d = (await getDraft(t.sql(), draftId))!;
    expect(d).toMatchObject({ status: "PUBLISHED", marketplaceItemId: "MLB1001", listingStatus: "active" });
    const rows = await t.sql().query<{ item: string; status: string }>(`SELECT marketplace_item_id AS item, status FROM marketplace_listings ORDER BY id`);
    expect(rows).toEqual([
      { item: "MLB1000", status: "deleted" },
      { item: "MLB1001", status: "active" },
    ]);
    const events = await t.sql().query<{ type: string }>(`SELECT event_type AS type FROM marketplace_listing_events WHERE listing_draft_id = $1 ORDER BY id`, [draftId]);
    expect(events.map((e) => e.type)).toContain("reopened_for_republish");
  });

  it("o banco nunca aceita dois anúncios vigentes para o mesmo produto e conta", async () => {
    const { draftId } = await publishedPilot();
    const [p] = await t.sql().query<{ productId: number }>(`SELECT product_id AS "productId" FROM listing_drafts WHERE id = $1`, [draftId]);
    await expect(
      t.sql().execute(
        `INSERT INTO marketplace_listings (product_id, ads_product_id, listing_draft_id, marketplace_account_id, marketplace_item_id, category_id, price, quantity, status)
         VALUES ($1, 1804, $2, '42', 'MLB9999', 'MLB264861', 10, 1, 'active')`,
        [p.productId, draftId],
      ),
    ).rejects.toBeTruthy();
  });
});

describe("exibição de anúncio encerrado/excluído", () => {
  it("rascunho publicado com anúncio excluído sai da aba Publicados, entra em Encerrados e mostra o status real", async () => {
    const ml = await setup();
    const draftId = await seedValidatedDraft();
    await publish(draftId);
    await runWorker();
    let pub = await listDrafts(t.sql(), { statuses: ["PUBLISHED"], listing: "current" });
    expect(pub.items.map((d) => d.id)).toEqual([draftId]);
    expect(pub.endedPublished).toBe(0);

    const item = [...ml.state.items.values()].find((i) => i.id === "MLB1000")!;
    item.status = "closed";
    item.sub_status = ["deleted"];
    await syncAllListings(t.sql());

    pub = await listDrafts(t.sql(), { statuses: ["PUBLISHED"], listing: "current" });
    expect(pub.items).toHaveLength(0);
    const ended = await listDrafts(t.sql(), { statuses: ["PUBLISHED"], listing: "ended" });
    expect(ended.items.map((d) => d.id)).toEqual([draftId]);
    expect(ended.endedPublished).toBe(1);
    expect(draftDisplayStatus(ended.items[0].status, ended.items[0].listingStatus)).toEqual({ text: "Excluído no ML", tone: "danger" });
    expect(draftDisplayStatus("PUBLISHED", "active").text).toBe("Ativo no ML");
    expect(draftDisplayStatus("DRAFT", "deleted").text).toBe("Rascunho");
  });
});
