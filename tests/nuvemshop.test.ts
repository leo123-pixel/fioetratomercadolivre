import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as authStart } from "@/app/api/auth/nuvemshop/route";
import { GET as connectionGet, POST as connectionPost } from "@/app/api/nuvemshop/connection/route";
import { POST as importPost } from "@/app/api/nuvemshop/import/route";
import { POST as mappingsPost } from "@/app/api/nuvemshop/mappings/route";
import { GET as productsGet } from "@/app/api/nuvemshop/products/route";
import { POST as webhookPost } from "@/app/api/webhooks/nuvemshop/[topic]/route";
import { NuvemshopInventoryAdapter } from "@/lib/inventory/adapters/nuvemshop";
import { runShadowReconciliation } from "@/lib/inventory/shadow";
import { InventoryWriteBlockedError } from "@/lib/inventory/mode";
import { gtinOf, normalizeSku, stockStateOf } from "@/lib/nuvemshop/catalog";
import { NuvemshopApiClient, NuvemshopApiError, resetNuvemshopThrottleForTests } from "@/lib/nuvemshop/client";
import { checkConnection } from "@/lib/nuvemshop/connection";
import { createImportJob, ImportConflictError, NS_LEASE, processNuvemshopJobs } from "@/lib/nuvemshop/import";
import { bulkConfirmSafe, confirmMapping, NuvemshopMappingError, refreshMappingSuggestions, rejectSuggestion, revokeMapping } from "@/lib/nuvemshop/mapping";
import { handleCallback, startAuthorization } from "@/lib/nuvemshop/oauth";
import { listVariants } from "@/lib/nuvemshop/queries";
import { issueWritePermit, NuvemshopWriteBlockedError, nuvemshopWriteEnv, WritePermit } from "@/lib/nuvemshop/write-gate";
import { disconnectStore, getConnectedStore } from "@/lib/nuvemshop/store";
import { updateStockSettings } from "@/lib/stock/settings";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { API, FakeNuvemshop, NS_SECRET, NS_STORE, NS_TOKEN, nsEnv, type FakeProduct } from "./helpers/nuvemshop-mock";
import { useTestDatabase } from "./helpers/pg";

/**
 * Fase 1 Nuvemshop: OAuth, catálogo, variantes, estoque, vinculação ADS e leitura pelo Inventory Core.
 * A Nuvemshop é simulada (FakeNuvemshop); nenhum produto, preço ou estoque real é tocado.
 */
const t = useTestDatabase();
const sql = () => t.sql();
const ACTOR = "admin:teste";
const noSleep = async () => {};
let ns: FakeNuvemshop;

beforeEach(() => {
  for (const [k, v] of Object.entries(nsEnv())) process.env[k] = v;
  resetNuvemshopThrottleForTests();
  ns = new FakeNuvemshop();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("NUVEMSHOP_")) delete process.env[k];
  delete process.env.INVENTORY_CORE_MODE;
});

async function connect(): Promise<void> {
  const { authorizationUrl, bindingNonce } = await startAuthorization(sql(), ACTOR);
  const state = new URL(authorizationUrl).searchParams.get("state");
  const r = await handleCallback(sql(), { code: "code-1", state, error: null, bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
  expect(r.ok).toBe(true);
}

async function importAll(mode: "FULL" | "INCREMENTAL" = "FULL") {
  const job = await createImportJob(sql(), { mode, actor: ACTOR });
  for (let i = 0; i < 50; i++) {
    const r = await processNuvemshopJobs({ sql: sql(), fetchImpl: ns.fetch, sleep: noSleep, retryBaseMs: 1, budgetMs: 60_000 });
    if (!r.more) break;
    // Espera de backoff: avança o relógio do job (testes não dormem).
    await sql().execute(`UPDATE nuvemshop_catalog_import_jobs SET next_run_at = now() WHERE id = $1::uuid`, [job.id]);
  }
  const [j] = await sql().query<{ status: string; mode: string; productsSeen: number; variantsSeen: number; createdCount: number; updatedCount: number; unchangedCount: number; removedCount: number; failedCount: number; lastError: string | null }>(
    `SELECT status, mode, products_seen AS "productsSeen", variants_seen AS "variantsSeen", created_count AS "createdCount", updated_count AS "updatedCount",
            unchanged_count AS "unchangedCount", removed_count AS "removedCount", failed_count AS "failedCount", last_error AS "lastError"
     FROM nuvemshop_catalog_import_jobs WHERE id = $1::uuid`,
    [job.id],
  );
  return j;
}

async function adsProduct(ads: number, o: { ean?: string; manufacturer?: string; kit?: boolean; stock?: number } = {}): Promise<number> {
  const [{ id }] = await sql().query<{ id: number }>(
    `INSERT INTO products (ads_product_id, name_original, ean, manufacturer_code, raw_payload) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [ads, `PRODUTO ADS ${ads}`, o.ean ?? null, o.manufacturer ?? null, JSON.stringify({ kit: o.kit ?? false })],
  );
  if (o.stock !== undefined) {
    await sql().execute(`INSERT INTO product_stocks (product_id, ads_product_id, branch_id, quantity, raw_payload) VALUES ($1, $2, '01', $3::numeric, '{}'::jsonb)`, [id, ads, String(o.stock)]);
  }
  return id;
}

const simple = (id: number, sku: string | null, o: Partial<FakeProduct> & { stock?: number | null; barcode?: string | null; stockManagement?: boolean } = {}): FakeProduct => ({
  id,
  name: { pt: `Produto ${id}` },
  images: [{ id: id * 10, src: `https://cdn.test/${id}.jpg`, position: 1 }],
  variants: [{ id: id * 100, sku, barcode: o.barcode ?? null, stock: o.stock === undefined ? 5 : o.stock, stock_management: o.stockManagement ?? true }],
  ...o,
});

const suggestions = (variantId: number) =>
  sql().query<{ productId: number; criterion: string; confidence: string; status: string }>(
    `SELECT product_id AS "productId", criterion, confidence, status FROM nuvemshop_variant_mappings WHERE variant_id = $1 ORDER BY id`,
    [variantId],
  );

// ---------------------------------------------------------------------------
describe("OAuth Nuvemshop", () => {
  it("autorização: state de uso único, token cifrado no banco, loja identificada por user_id e confirmada em GET /store", async () => {
    const { authorizationUrl } = await startAuthorization(sql(), ACTOR);
    expect(authorizationUrl).toMatch(/^https:\/\/www\.nuvemshop\.com\.br\/apps\/9876\/authorize\?state=/);
    await connect();
    const store = await getConnectedStore(sql());
    expect(store).toMatchObject({ storeId: NS_STORE, storeName: "Loja Teste", planName: "BR_test_plan", connectionStatus: "ACTIVE" });
    const [raw] = await sql().query<{ token: string; rawStore: Record<string, unknown> }>(`SELECT encrypted_access_token AS token, raw_store AS "rawStore" FROM nuvemshop_stores`);
    expect(raw.token).not.toContain(NS_TOKEN);
    expect(raw.rawStore.email).toBeUndefined(); // dado pessoal do lojista não é guardado
    const tokenCall = ns.calls.find((c) => c.url.endsWith("/apps/authorize/token"))!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).not.toContain("client_secret"); // credenciais no corpo, nunca na URL
  });

  it("state inválido, ausente, reutilizado ou de outro navegador é recusado sem gravar nada", async () => {
    expect((await handleCallback(sql(), { code: "c", state: null, error: null, bindingNonce: "x", actor: ACTOR }, { fetchImpl: ns.fetch })).ok).toBe(false);
    const { authorizationUrl, bindingNonce } = await startAuthorization(sql(), ACTOR);
    const state = new URL(authorizationUrl).searchParams.get("state");
    const wrongBrowser = await handleCallback(sql(), { code: "c", state, error: null, bindingNonce: "outro", actor: ACTOR }, { fetchImpl: ns.fetch });
    expect(wrongBrowser).toEqual({ ok: false, error: "invalid_state" });
    const ok = await handleCallback(sql(), { code: "c", state, error: null, bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
    expect(ok.ok).toBe(true);
    const reused = await handleCallback(sql(), { code: "c", state, error: null, bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
    expect(reused).toEqual({ ok: false, error: "invalid_state" });
  });

  it("code inválido e token que a API recusa: nada é gravado", async () => {
    ns.tokenError = "invalid_grant";
    const a = await startAuthorization(sql(), ACTOR);
    const r1 = await handleCallback(sql(), { code: "ruim", state: new URL(a.authorizationUrl).searchParams.get("state"), error: null, bindingNonce: a.bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
    expect(r1).toEqual({ ok: false, error: "token_exchange_failed" });
    ns.tokenError = null;
    ns.token = "token-da-troca";
    const fetchWrongToken: typeof fetch = async (input, init) => {
      if (String(input).includes("/store")) return new Response(JSON.stringify({ code: 401 }), { status: 401 });
      return ns.fetch(input, init);
    };
    const b = await startAuthorization(sql(), ACTOR);
    const r2 = await handleCallback(sql(), { code: "ok", state: new URL(b.authorizationUrl).searchParams.get("state"), error: null, bindingNonce: b.bindingNonce, actor: ACTOR }, { fetchImpl: fetchWrongToken });
    expect(r2).toEqual({ ok: false, error: "store_verification_failed" });
    expect(await getConnectedStore(sql())).toBeNull();
  });

  it("reinstalação substitui o token da mesma loja; outra loja não é conectada por cima; loja incorreta e escopo insuficiente são recusados", async () => {
    await connect();
    ns.token = "novo-token-apos-reinstalar";
    const a = await startAuthorization(sql(), ACTOR);
    const re = await handleCallback(sql(), { code: "c2", state: new URL(a.authorizationUrl).searchParams.get("state"), error: null, bindingNonce: a.bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
    expect(re).toMatchObject({ ok: true, reinstalled: true });
    const [{ v }] = await sql().query<{ v: number }>(`SELECT token_version AS v FROM nuvemshop_stores`);
    expect(v).toBe(2);
    // O token novo é o usado nas chamadas.
    expect((await checkConnection(sql(), { fetchImpl: ns.fetch })).ok).toBe(true);

    // Loja incorreta: user_id do token diferente do id devolvido por /store.
    ns.storeIdForToken = "5555";
    const b = await startAuthorization(sql(), ACTOR);
    const fetchOtherStore: typeof fetch = async (input, init) => {
      if (String(input).includes("/2025-03/5555/store")) return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
      return ns.fetch(input, init);
    };
    const mismatch = await handleCallback(sql(), { code: "c3", state: new URL(b.authorizationUrl).searchParams.get("state"), error: null, bindingNonce: b.bindingNonce, actor: ACTOR }, { fetchImpl: fetchOtherStore });
    expect(mismatch).toEqual({ ok: false, error: "store_mismatch" });

    // Outra loja válida enquanto a primeira está conectada: recusada.
    const fetchStore5555: typeof fetch = async (input, init) => {
      if (String(input).includes("/2025-03/5555/store")) return new Response(JSON.stringify({ id: 5555, name: { pt: "Outra" } }), { status: 200 });
      return ns.fetch(input, init);
    };
    const c = await startAuthorization(sql(), ACTOR);
    const other = await handleCallback(sql(), { code: "c4", state: new URL(c.authorizationUrl).searchParams.get("state"), error: null, bindingNonce: c.bindingNonce, actor: ACTOR }, { fetchImpl: fetchStore5555 });
    expect(other).toMatchObject({ ok: false, error: "other_store_connected" });

    ns.storeIdForToken = NS_STORE;
    ns.scope = "read_orders";
    const d = await startAuthorization(sql(), ACTOR);
    const scope = await handleCallback(sql(), { code: "c5", state: new URL(d.authorizationUrl).searchParams.get("state"), error: null, bindingNonce: d.bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
    expect(scope).toMatchObject({ ok: false, error: "insufficient_scope" });
  });

  it("token revogado (401) marca reautorização; desconexão apaga o token local", async () => {
    await connect();
    ns.token = "token-revogado-pela-loja";
    const check = await checkConnection(sql(), { fetchImpl: ns.fetch });
    expect(check).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    expect((await getConnectedStore(sql()))?.connectionStatus).toBe("REAUTH_REQUIRED");
    await disconnectStore(sql(), ACTOR);
    const [s] = await sql().query<{ status: string; token: string | null }>(`SELECT connection_status AS status, encrypted_access_token AS token FROM nuvemshop_stores`);
    expect(s).toEqual({ status: "DISCONNECTED", token: null });
  });
});

// ---------------------------------------------------------------------------
describe("Catálogo e variantes", () => {
  it("importação completa paginada, sem duplicar; segunda importação não cria nada; incremental só busca o que mudou", async () => {
    await connect();
    ns.products = Array.from({ length: 55 }, (_, i) => simple(1000 + i, `SKU-${i}`));
    const first = await importAll("FULL");
    expect(first).toMatchObject({ status: "COMPLETED", productsSeen: 55, variantsSeen: 55, createdCount: 55 });
    expect(ns.calls.filter((c) => c.url.includes("/products?")).length).toBe(2); // 50 + 5
    const again = await importAll("FULL");
    expect(again).toMatchObject({ status: "COMPLETED", createdCount: 0, unchangedCount: 55 });
    const [{ n }] = await sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM nuvemshop_variants`);
    expect(n).toBe(55);

    ns.products[3] = { ...ns.products[3], name: { pt: "Nome alterado" }, updated_at: "2099-01-01T00:00:00+0000" };
    ns.calls = [];
    const inc = await importAll("INCREMENTAL");
    expect(inc).toMatchObject({ mode: "INCREMENTAL", status: "COMPLETED", productsSeen: 1, updatedCount: 1 });
    expect(ns.calls.some((c) => c.url.includes("updated_at_min="))).toBe(true);
    const [p] = await sql().query<{ name: string }>(`SELECT name FROM nuvemshop_products WHERE product_id = 1003`);
    expect(p.name).toBe("Nome alterado");
  });

  it("variante virtual, várias variantes, variantes fora do payload, SKU ausente/duplicado, GTIN inválido e imagem inexistente", async () => {
    await connect();
    ns.products = [
      simple(1, "ADS-10", { images: [] }), // produto simples: variante "virtual" única, sem imagem
      { id: 2, name: { pt: "Shampoo" }, variants: [{ id: 21, sku: "SH-P", values: [{ pt: "300ml" }] }, { id: 22, sku: "SH-G", values: [{ pt: "1L" }] }] },
      { id: 3, name: { pt: "Sem variantes no payload" }, omitVariants: true, variants: [{ id: 31, sku: "X-31" }] },
      simple(4, null),
      simple(5, "DUP"),
      simple(6, " dup "),
      simple(7, "G1", { barcode: "7891234567890" }), // dígito verificador inválido
    ];
    const j = await importAll("FULL");
    expect(j.status).toBe("COMPLETED");
    expect(ns.calls.some((c) => c.url.includes("/products/3/variants"))).toBe(true);
    const store = NS_STORE;
    const all = await listVariants(sql(), { storeId: store, filter: "all", pageSize: 100 });
    expect(all.total).toBe(8);
    expect(all.counts.no_sku).toBe(1);
    expect(all.counts.duplicate_sku).toBe(2); // "DUP" e " dup " normalizam igual
    const v7 = all.items.find((v) => v.variantId === "700")!;
    expect(v7).toMatchObject({ barcode: "7891234567890", gtin: null });
    expect(all.items.find((v) => v.variantId === "100")!.imageSrc).toBeNull();
    expect(normalizeSku("  ads-10 ")).toBe("ADS-10");
    expect(gtinOf("7891234567895")).toBe("7891234567895");
  });

  it("produto removido na loja e variante recriada: marcados, vínculo vai para revisão e a nova variante recebe sugestão pelo vínculo existente", async () => {
    await connect();
    const p = await adsProduct(10);
    ns.products = [simple(1, "ADS-10"), simple(2, "OUTRO")];
    await importAll("FULL");
    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: p, actor: ACTOR });
    // Variante 100 recriada como 101 (mesmo SKU); produto 2 removido.
    ns.products = [{ ...simple(1, "ADS-10"), variants: [{ id: 101, sku: "ADS-10" }] }];
    const j = await importAll("FULL");
    expect(j.removedCount).toBeGreaterThanOrEqual(2);
    const [old] = await sql().query<{ status: string; reason: string }>(`SELECT status, review_reason AS reason FROM nuvemshop_variant_mappings WHERE variant_id = 100 AND status <> 'SUPERSEDED'`);
    expect(old).toMatchObject({ status: "NEEDS_REVIEW" });
    expect(old.reason).toMatch(/removida/);
    expect((await suggestions(101)).find((s) => s.status === "SUGGESTED")).toMatchObject({ productId: p, criterion: "EXISTING_LINK", confidence: "HIGH" });
    const [p2] = await sql().query<{ status: string }>(`SELECT sync_status AS status FROM nuvemshop_products WHERE product_id = 2`);
    expect(p2.status).toBe("REMOVED");
  });
});

// ---------------------------------------------------------------------------
describe("Vinculação ADS", () => {
  beforeEach(async () => {
    await connect();
  });

  it("SKU ADS único e GTIN único viram sugestão de confiança alta; ambíguo exige escolha; nada é confirmado sozinho", async () => {
    const a = await adsProduct(10);
    const b = await adsProduct(20, { ean: "7891234567895" });
    await adsProduct(30, { ean: "7896543210982" });
    await adsProduct(31, { ean: "07896543210982" });
    ns.products = [simple(1, "ADS-10"), simple(2, "XYZ", { barcode: "7891234567895" }), simple(3, "QQQ", { barcode: "7896543210982" }), simple(4, "NADA")];
    await importAll("FULL");
    expect((await suggestions(100))[0]).toMatchObject({ productId: a, criterion: "SKU_MATCH", confidence: "HIGH", status: "SUGGESTED" });
    expect((await suggestions(200))[0]).toMatchObject({ productId: b, criterion: "GTIN_MATCH", confidence: "HIGH" });
    expect((await suggestions(300)).filter((s) => s.status === "SUGGESTED")).toHaveLength(2); // ambíguo
    expect(await suggestions(400)).toHaveLength(0); // produto não encontrado
    const [{ n }] = await sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM nuvemshop_variant_mappings WHERE status = 'CONFIRMED'`);
    expect(n).toBe(0);
    const counts = (await listVariants(sql(), { storeId: NS_STORE })).counts;
    expect(counts).toMatchObject({ pending: 2, ambiguous: 1, unlinked: 4, linked: 0 });
  });

  it("lote confirma só as seguras; manual, rejeição, correção e desvinculação ficam no histórico", async () => {
    const a = await adsProduct(10);
    await adsProduct(30, { ean: "7896543210982" });
    await adsProduct(31, { ean: "07896543210982" });
    const m = await adsProduct(40);
    ns.products = [simple(1, "ADS-10"), simple(3, "QQQ", { barcode: "7896543210982" }), simple(4, "MANUAL")];
    await importAll("FULL");
    const bulk = await bulkConfirmSafe(sql(), { storeId: NS_STORE, actor: ACTOR, variantIds: ["100", "300", "400"] });
    expect(bulk.confirmed).toBe(1);
    expect(bulk.skipped.map((s) => s.reason).sort()).toEqual(["correspondência ambígua", "sem sugestão"]);

    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "400", productId: m, actor: ACTOR });
    const corrected = await confirmMapping(sql(), { storeId: NS_STORE, variantId: "400", productId: a, actor: ACTOR });
    expect(corrected.corrected).toBe(true);
    await expect(revokeMapping(sql(), { storeId: NS_STORE, variantId: "400", actor: ACTOR, reason: "" })).rejects.toThrow(NuvemshopMappingError);
    await revokeMapping(sql(), { storeId: NS_STORE, variantId: "400", actor: ACTOR, reason: "produto errado" });
    const [x30] = await sql().query<{ id: number }>(`SELECT id FROM products WHERE ads_product_id = 30`);
    await rejectSuggestion(sql(), { storeId: NS_STORE, variantId: "300", productId: x30.id, actor: ACTOR });
    await refreshMappingSuggestions(sql(), NS_STORE);
    expect((await suggestions(300)).filter((s) => s.status === "SUGGESTED").map((s) => s.productId)).not.toContain(x30.id);
    const hist = await sql().query<{ action: string }>(`SELECT action FROM nuvemshop_mapping_history WHERE variant_id = 400 ORDER BY id`);
    expect(hist.map((h) => h.action)).toEqual(["CONFIRMED", "CORRECTED", "REVOKED"]);
    await expect(sql().execute(`DELETE FROM nuvemshop_mapping_history`)).rejects.toThrow(/somente inserção/);
  });

  it("kit exige composição formal; produto ADS inexistente é recusado", async () => {
    const kit = await adsProduct(50, { kit: true });
    const c1 = await adsProduct(51);
    ns.products = [simple(1, "ADS-50", { is_kit: true })];
    await importAll("FULL");
    await expect(confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: kit, actor: ACTOR })).rejects.toMatchObject({ code: "kit_requires_components" });
    expect((await bulkConfirmSafe(sql(), { storeId: NS_STORE, actor: ACTOR, variantIds: ["100"] })).skipped[0].reason).toBe("kit exige composição manual");
    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: kit, actor: ACTOR, components: [{ productId: c1, quantity: 2 }] });
    await expect(confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: 999999, actor: ACTOR })).rejects.toMatchObject({ code: "product_not_found" });
  });
});

// ---------------------------------------------------------------------------
describe("Estoque Nuvemshop (somente leitura) e Inventory Core", () => {
  beforeEach(async () => {
    await connect();
  });

  async function mapLocation(id: string, status: "MAPPED" | "UNMAPPED" | "EXCLUDED", code: string | null = "principal") {
    await sql().execute(`UPDATE nuvemshop_locations SET mapping_status = $2, warehouse_code = $3 WHERE location_id = $1`, [id, status, status === "MAPPED" ? code : null]);
  }

  it("uma localização, várias localizações, zero, ilimitado, desconhecido e localização não mapeada", async () => {
    ns.locations = [
      { id: "LOC-A", name: { pt_BR: "A" }, is_default: true },
      { id: "LOC-B", name: { pt_BR: "B" } },
    ];
    const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => adsProduct(n)));
    ns.products = [
      simple(1, "ADS-1", { stock: 7 }), // sem inventory_levels → atribuído à localização padrão
      { id: 2, name: { pt: "Multi" }, variants: [{ id: 200, sku: "ADS-2", stock: 9, inventory_levels: [{ location_id: "LOC-A", stock: 4 }, { location_id: "LOC-B", stock: 5 }] }] },
      simple(3, "ADS-3", { stock: 0 }),
      simple(4, "ADS-4", { stockManagement: false, stock: null }),
      { id: 5, name: { pt: "Sem B" }, variants: [{ id: 500, sku: "ADS-5", stock: 3, inventory_levels: [{ location_id: "LOC-A", stock: 3 }, { location_id: "LOC-B", stock: 0 }] }] },
    ];
    await importAll("FULL");
    for (const [i, id] of ids.entries()) await confirmMapping(sql(), { storeId: NS_STORE, variantId: String((i + 1) * 100), productId: id, actor: ACTOR });
    const adapter = new NuvemshopInventoryAdapter(sql(), "principal");
    // Nada mapeado ainda: estoque em localização sem associação = desconhecido (nunca zero).
    let snap = new Map((await adapter.getInventorySnapshot()).map((s) => [s.variantId, s]));
    expect(snap.get("100")!.observed).toBeNull();
    await mapLocation("LOC-A", "MAPPED");
    snap = new Map((await adapter.getInventorySnapshot()).map((s) => [s.variantId, s]));
    expect(snap.get("100")!.observed).toBe(7);
    expect(snap.get("200")!.observed).toBeNull(); // LOC-B tem 5 e não está mapeada
    expect(snap.get("300")!.observed).toBe(0);
    expect(snap.get("400")).toMatchObject({ observed: null, observedReason: expect.stringMatching(/ilimitado/) });
    expect(snap.get("500")!.observed).toBe(3); // LOC-B com zero não atrapalha
    await mapLocation("LOC-B", "EXCLUDED");
    snap = new Map((await adapter.getInventorySnapshot()).map((s) => [s.variantId, s]));
    expect(snap.get("200")!.observed).toBe(4);
    expect(stockStateOf({ stockManagement: true, stock: null })).toBe("UNKNOWN");
    await expect(adapter.applyStockUpdate(adapter.prepareStockUpdate((await adapter.getChannelInventory())[0], 1))).rejects.toThrow(InventoryWriteBlockedError);
  });

  it("cota simulada pelo Inventory Core: ADS 10, reserva 2 → ML 4 + Nuvemshop 4 (simulada), observado lido, nenhuma escrita remota", async () => {
    process.env.INVENTORY_CORE_MODE = "shadow";
    await sql().execute(`INSERT INTO inventory_allocation_policies (scope, version, safety_reserve, remainder_mode, rules, created_by)
      VALUES ('GLOBAL', 1, 2, 'PRIORITY', '[{"channel":"mercadolivre","type":"PERCENT","value":50,"priority":1},{"channel":"nuvemshop","type":"PERCENT","value":50,"priority":2}]', 'teste')`);
    await updateStockSettings(sql(), { branchIds: ["01"] }, ACTOR);
    const p = await adsProduct(77, { stock: 10 });
    ns.products = [simple(1, "ADS-77", { stock: 4 })];
    await importAll("FULL");
    await mapLocation("LOC-A", "MAPPED");
    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: p, actor: ACTOR });
    const before = ns.calls.length;
    const run = await runShadowReconciliation(sql(), { requestedBy: ACTOR });
    expect(run.summary.remoteWrites).toBe(0);
    expect(ns.calls.length).toBe(before); // a reconciliação lê só o banco
    const [pos] = await sql().query<{ safe: number; reserve: number; ml: number; nsDesired: number; nsObserved: number; nsStatus: string }>(
      `SELECT ip.safe_sellable AS safe, ip.safety_reserve AS reserve, ml.desired_quantity AS ml, ns.desired_quantity AS "nsDesired", ns.confirmed_quantity AS "nsObserved", ns.status AS "nsStatus"
       FROM inventory_pools ip JOIN inventory_channel_allocations ml ON ml.pool_id = ip.id AND ml.channel = 'mercadolivre'
       JOIN inventory_channel_allocations ns ON ns.pool_id = ip.id AND ns.channel = 'nuvemshop' WHERE ip.product_id = $1`,
      [p],
    );
    expect(pos).toEqual({ safe: 8, reserve: 2, ml: 4, nsDesired: 4, nsObserved: 4, nsStatus: "SIMULATED" });
    expect(ns.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("Infraestrutura: limite, retentativa, falhas, concorrência e idempotência", () => {
  const client = (fetchImpl: typeof fetch, sleeps: number[] = []) =>
    new NuvemshopApiClient({ storeId: NS_STORE, accessToken: NS_TOKEN, env: { apiBaseUrl: "https://api.tiendanube.com/2025-03", userAgent: "Teste (https://integrador.test)" }, fetchImpl, sleep: async (ms) => void sleeps.push(ms), retryBaseMs: 10 });

  it("429 espera o x-rate-limit-reset; 5xx, timeout e falha de rede repetem com limite; 401/403 não repetem", async () => {
    const sleeps: number[] = [];
    ns.failures.set("/store", [429, 503, "timeout", "network"]);
    const c = client(ns.fetch, sleeps);
    const r = await c.get<{ id: number }>("/store");
    expect(r.data.id).toBe(4242);
    expect(c.metrics).toMatchObject({ retries: 4, rateLimited: 1 });
    expect(sleeps[0]).toBe(10); // reset de 5 ms < base: usa o backoff
    ns.failures.set("/store", [500, 500, 500, 500, 500, 500]);
    await expect(client(ns.fetch).get("/store")).rejects.toMatchObject({ kind: "server" });
    ns.failures.set("/store", [403, 200]);
    await expect(client(ns.fetch).get("/store")).rejects.toMatchObject({ kind: "forbidden" });
    const bad = new NuvemshopApiClient({ storeId: NS_STORE, accessToken: "x", env: { apiBaseUrl: "https://api.tiendanube.com/2025-03", userAgent: "T (t)" }, fetchImpl: ns.fetch, sleep: noSleep });
    await expect(bad.get("/store")).rejects.toBeInstanceOf(NuvemshopApiError);
  });

  it("importação: falha transitória repete e conclui; falha definitiva encerra como FAILED; worker reiniciado retoma do cursor", async () => {
    await connect();
    ns.products = Array.from({ length: 60 }, (_, i) => simple(2000 + i, `S${i}`));
    ns.failures.set("/products", Array(6).fill(503)); // > tentativas do cliente: a etapa volta para a fila
    const j = await importAll("FULL");
    expect(j.status).toBe("COMPLETED");
    const [{ retries }] = await sql().query<{ retries: number }>(`SELECT count(*)::int AS retries FROM nuvemshop_catalog_import_attempts WHERE outcome = 'RETRY'`);
    expect(retries).toBeGreaterThan(0);

    // Interrupção no meio: lease de outro worker expirado + job RUNNING na página 2.
    const job = await createImportJob(sql(), { mode: "FULL", actor: ACTOR });
    await sql().execute(`UPDATE nuvemshop_catalog_import_jobs SET status = 'RUNNING', cursor = '{"phase":"products","page":2}' WHERE id = $1::uuid`, [job.id]);
    await sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ($1, 'morto', now() - interval '1 minute')`, [NS_LEASE]);
    ns.calls = [];
    await processNuvemshopJobs({ sql: sql(), fetchImpl: ns.fetch, sleep: noSleep, retryBaseMs: 1 });
    expect(ns.calls.some((c) => c.url.includes("page=1&") || c.url.endsWith("page=1"))).toBe(false);
    const [done] = await sql().query<{ status: string }>(`SELECT status FROM nuvemshop_catalog_import_jobs WHERE id = $1::uuid`, [job.id]);
    expect(done.status).toBe("COMPLETED");

    ns.token = "revogado";
    const failed = await importAll("FULL");
    expect(failed.status).toBe("FAILED");
    expect((await getConnectedStore(sql()))?.connectionStatus).toBe("REAUTH_REQUIRED");
  });

  it("concorrência: uma importação ativa por loja e um worker por vez", async () => {
    await connect();
    await createImportJob(sql(), { mode: "FULL", actor: ACTOR });
    await expect(createImportJob(sql(), { mode: "FULL", actor: ACTOR })).rejects.toBeInstanceOf(ImportConflictError);
    await sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ($1, 'outro', now() + interval '1 minute')`, [NS_LEASE]);
    expect(await processNuvemshopJobs({ sql: sql(), fetchImpl: ns.fetch, sleep: noSleep })).toMatchObject({ busy: true });
  });
});

// ---------------------------------------------------------------------------
describe("Portão de escrita e rotas", () => {
  it("portão: sem NUVEMSHOP_WRITE_ENABLED=true, sem write_products ou com emergência ativa recusa; o cliente recusa escrita sem permissão", async () => {
    const store = { storeId: NS_STORE, grantedScopes: "read_products,write_products" };
    expect(nuvemshopWriteEnv({})).toMatchObject({ enabled: false, warning: expect.any(String) });
    await expect(issueWritePermit(sql(), store, "STOCK", "PATCH /products/stock-price")).rejects.toBeInstanceOf(NuvemshopWriteBlockedError);
    process.env.NUVEMSHOP_WRITE_ENABLED = "true";
    await expect(issueWritePermit(sql(), { ...store, grantedScopes: "read_products" }, "PRICE", "x")).rejects.toThrow(/write_products/);
    await sql().execute(`UPDATE nuvemshop_emergency_stop SET active = true, reason = 'teste'`);
    await expect(issueWritePermit(sql(), store, "CATALOG", "x")).rejects.toThrow(/emergência/);
    await sql().execute(`UPDATE nuvemshop_emergency_stop SET active = false`);
    const permit = await issueWritePermit(sql(), store, "STOCK", "x");
    expect(permit).toBeInstanceOf(WritePermit);
    expect(() => new WritePermit(Symbol("falso"), NS_STORE, "STOCK")).toThrow();
    const c = new NuvemshopApiClient({ storeId: NS_STORE, accessToken: NS_TOKEN, env: { apiBaseUrl: "https://api.tiendanube.com/2025-03", userAgent: "T (t)" }, fetchImpl: ns.fetch });
    await expect(c.send({} as WritePermit, "PUT", "/products/1/variants/1", {}, { idempotent: true })).rejects.toBeInstanceOf(NuvemshopWriteBlockedError);
    await expect(c.send(await issueWritePermit(sql(), { ...store, storeId: "999" }, "STOCK", "x"), "PUT", "/products/1", {}, { idempotent: true })).rejects.toThrow(/outra loja/);
    expect(ns.calls).toHaveLength(0);
  });

  it("varredura: escrita HTTP só pelo cliente com permissão do portão (e a troca do code no servidor de autorização)", () => {
    const roots = ["src/lib/nuvemshop", "src/app/api/nuvemshop", "src/app/api/auth/nuvemshop", "src/app/api/webhooks/nuvemshop"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(f)) files.push(full);
      }
    };
    for (const r of roots) walk(join(process.cwd(), r));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const writes = text.match(/method:\s*["'](PUT|POST|PATCH|DELETE)["']/g) ?? [];
      const allowed = f.replace(/\\/g, "/").endsWith("src/lib/nuvemshop/oauth.ts") ? 1 : 0;
      expect({ file: f, writes: writes.length }).toEqual({ file: f, writes: allowed });
      // Quem chama client.send() precisa obter a permissão do portão no mesmo módulo.
      if (/\.send(<[^>]*>)?\(\s*permit/.test(text)) expect({ file: f, gate: /issueWritePermit\(/.test(text) }).toEqual({ file: f, gate: true });
      // Ninguém chama a API da Nuvemshop por fetch direto (só pelo cliente).
      expect({ file: f, fetch: /fetch\(\s*["'`]https:\/\/api\.(tiendanube|nuvemshop)/.test(text) }).toEqual({ file: f, fetch: false });
    }
  });

  it("rotas exigem administrador e mesma origem; conexão não expõe token; produtos listam dados locais", async () => {
    expect((await connectionGet(makeRequest("/api/nuvemshop/connection"))).status).toBe(401);
    expect((await importPost(makeRequest("/api/nuvemshop/import", { method: "POST", cookies: adminCookies(), body: {} }))).status).toBe(403);
    const start = await authStart(makeRequest("/api/auth/nuvemshop", { cookies: adminCookies() }));
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toMatch(/nuvemshop\.com\.br\/apps\/9876\/authorize/);
    await connect();
    const view = await (await connectionGet(makeRequest("/api/nuvemshop/connection", { cookies: adminCookies() }))).json();
    expect(JSON.stringify(view)).not.toContain(NS_TOKEN);
    expect(JSON.stringify(view)).not.toMatch(/encrypted|v1\./);
    ns.products = [simple(1, "ADS-1")];
    await importAll("FULL");
    const list = await (await productsGet(makeRequest("/api/nuvemshop/products?filter=all", { cookies: adminCookies() }))).json();
    expect(list.total).toBe(1);
    const bad = await mappingsPost(makeRequest("/api/nuvemshop/mappings", { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "confirm", variantId: "abc" } }));
    expect(bad.status).toBe(422);
    // Verificação real da conexão pela rota (fetch global → Nuvemshop simulada).
    const original = globalThis.fetch;
    globalThis.fetch = ns.fetch as unknown as typeof fetch;
    try {
      const chk = await (await connectionPost(makeRequest("/api/nuvemshop/connection", { method: "POST", cookies: adminCookies(), headers: { origin: BASE } }))).json();
      expect(chk).toMatchObject({ ok: true, storeId: NS_STORE, locations: 1 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("webhooks de privacidade exigem assinatura HMAC; store/redact apaga token e catálogo", async () => {
    await connect();
    ns.products = [simple(1, "ADS-1")];
    await importAll("FULL");
    const body = JSON.stringify({ store_id: Number(NS_STORE) });
    const ctx = { params: Promise.resolve({ topic: "store-redact" }) };
    const unsigned = await webhookPost(makeRequest("/api/webhooks/nuvemshop/store-redact", { method: "POST", body: JSON.parse(body) }), ctx);
    expect(unsigned.status).toBe(401);
    const sig = createHmac("sha256", NS_SECRET).update(body).digest("hex");
    const req = makeRequest("/api/webhooks/nuvemshop/store-redact", { method: "POST", headers: { "x-linkedstore-hmac-sha256": sig }, body: JSON.parse(body) });
    const ok = await webhookPost(req, { params: Promise.resolve({ topic: "store-redact" }) });
    expect(ok.status).toBe(200);
    const [s] = await sql().query<{ status: string; token: string | null }>(`SELECT connection_status AS status, encrypted_access_token AS token FROM nuvemshop_stores`);
    expect(s).toEqual({ status: "DISCONNECTED", token: null });
    const [{ n }] = await sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM nuvemshop_product_images`);
    expect(n).toBe(0);
  });

  it("base da API usa a versão estável 2025-03", () => {
    expect(API).toContain("/2025-03/");
  });
});
