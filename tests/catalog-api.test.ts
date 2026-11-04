import { describe, expect, it } from "vitest";
import { POST as importPrices } from "@/app/api/import/prices/route";
import { POST as importProducts } from "@/app/api/import/products/route";
import { POST as importStocks } from "@/app/api/import/stocks/route";
import { GET as jobDetail } from "@/app/api/import/jobs/[id]/route";
import { GET as jobsList } from "@/app/api/import/jobs/route";
import { POST as retryRoute } from "@/app/api/import/jobs/[id]/retry/route";
import { POST as workerRoute } from "@/app/api/import/worker/route";
import { GET as draftGet, PATCH as draftPatch } from "@/app/api/listing-drafts/[id]/route";
import { GET as draftsList, POST as draftsCreate } from "@/app/api/listing-drafts/route";
import { GET as priceTables } from "@/app/api/price-tables/route";
import { GET as productGet, PATCH as productPatch } from "@/app/api/products/[id]/route";
import { GET as productPrices } from "@/app/api/products/[id]/prices/route";
import { POST as productRefresh } from "@/app/api/products/[id]/refresh/route";
import { GET as productStock } from "@/app/api/products/[id]/stock/route";
import { GET as productsList } from "@/app/api/products/route";
import { PATCH as setDefaultTable } from "@/app/api/settings/default-price-table/route";
import { setSchedulerForTesting, workerToken } from "@/lib/imports/scheduler";
import { processJobs } from "@/lib/imports/worker";
import { defaultData, mockAds, price, product, stock, table, type AdsData } from "./helpers/ads-mock";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { useTestDatabase } from "./helpers/pg";

const t = useTestDatabase();
const SAME = { origin: BASE };
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

function get(path: string) {
  return makeRequest(path, { cookies: adminCookies() });
}
function send(path: string, method: string, body?: unknown, headers: Record<string, string> = SAME) {
  return makeRequest(path, { method, cookies: adminCookies(), headers, body });
}

async function runWorker() {
  for (let i = 0; i < 20; i++) {
    const r = await processJobs({ sql: t.sql(), budgetMs: 5000, sleep: async () => {} });
    if (!r.more) return;
  }
}

/** Catálogo de exemplo baseado nos dados reais informados (IDs 1804 e 5653). */
function sampleData(): AdsData {
  const data = defaultData();
  data.products = [
    product(1804, { descricao: "LOREAL P OXIDANTE CR 950ML 20VOL", codFab: "H0269721", ean13: "7896014106226" }),
    product(5653, { descricao: "SHAMPOO HIDRATANTE 1L", fornecId: 600 }),
    product(7000, { descricao: "MASCARA INATIVA", inativo: true }),
    product(7001, { descricao: "CONDICIONADOR SEM PRECO" }),
  ];
  data.suppliers.push({ fornecId: 600, nome: "OUTRO FORNECEDOR", fantasia: null, inativo: false });
  data.tables.push(table("H", "PROMOÇÃO PROFISSIONA", { inativo: true }));
  data.prices = [
    price(1804, "F", 88.2),
    price(1804, "G", 99.9),
    price(5653, "F", 40, { inativo: true }),
    price(5653, "G", 45.5),
  ];
  data.stocks = [stock(1804, 0), stock(5653, 3)];
  return data;
}

async function seedCatalog(data = sampleData()) {
  const mock = mockAds(data);
  for (const route of [importProducts, importPrices, importStocks]) {
    const res = await route(send("/api/import/x", "POST", {}));
    expect(res.status).toBe(202);
    await runWorker();
  }
  return mock;
}

async function idOf(ads: number): Promise<number> {
  const [{ id }] = await t.sql().query<{ id: number }>(`SELECT id FROM products WHERE ads_product_id = $1`, [ads]);
  return id;
}

describe("acesso não autorizado", () => {
  it("todas as rotas novas exigem sessão de administrador", async () => {
    const anon = (path: string, method = "GET") => makeRequest(path, { method, headers: SAME, body: method === "GET" ? undefined : {} });
    const p = ctx({ id: "1" });
    const responses = await Promise.all([
      productsList(anon("/api/products")),
      productGet(anon("/api/products/1"), p),
      productPatch(anon("/api/products/1", "PATCH"), p),
      productPrices(anon("/api/products/1/prices"), p),
      productStock(anon("/api/products/1/stock"), p),
      productRefresh(anon("/api/products/1/refresh", "POST"), p),
      importProducts(anon("/api/import/products", "POST")),
      importPrices(anon("/api/import/prices", "POST")),
      importStocks(anon("/api/import/stocks", "POST")),
      jobsList(anon("/api/import/jobs")),
      jobDetail(anon("/api/import/jobs/x"), ctx({ id: "x" })),
      retryRoute(anon("/api/import/jobs/x/retry", "POST"), ctx({ id: "x" })),
      priceTables(anon("/api/price-tables")),
      setDefaultTable(anon("/api/settings/default-price-table", "PATCH")),
      draftsList(anon("/api/listing-drafts")),
      draftsCreate(anon("/api/listing-drafts", "POST")),
      draftGet(anon("/api/listing-drafts/1"), p),
      draftPatch(anon("/api/listing-drafts/1", "PATCH"), p),
    ]);
    expect(responses.map((r) => r.status)).toEqual(responses.map(() => 401));
  });

  it("rotas que alteram dados rejeitam outra origem (CSRF)", async () => {
    const res = await importProducts(send("/api/import/products", "POST", {}, { origin: "https://atacante.example" }));
    expect(res.status).toBe(403);
    expect(await t.sql().query(`SELECT 1 FROM import_jobs`)).toHaveLength(0);
  });

  it("o worker interno exige o token derivado do SESSION_SECRET", async () => {
    let scheduled = 0;
    setSchedulerForTesting(() => void scheduled++);
    expect((await workerRoute(makeRequest("/api/import/worker", { method: "POST" }))).status).toBe(401);
    expect((await workerRoute(makeRequest("/api/import/worker", { method: "POST", headers: { "x-worker-token": "falso" } }))).status).toBe(401);
    const ok = await workerRoute(makeRequest("/api/import/worker", { method: "POST", headers: { "x-worker-token": workerToken() } }));
    expect(ok.status).toBe(202);
    expect(scheduled).toBe(1);
  });
});

describe("importações via API", () => {
  it("cria a tarefa sem bloquear (202), agenda o worker e impede duplicidade (409)", async () => {
    mockAds(sampleData());
    let scheduled = 0;
    setSchedulerForTesting(() => void scheduled++);
    const first = await importProducts(send("/api/import/products", "POST", {}));
    expect(first.status).toBe(202);
    const { job } = await first.json();
    expect(job).toMatchObject({ type: "PRODUCTS", status: "PENDING" });
    expect(scheduled).toBe(1);
    const second = await importProducts(send("/api/import/products", "POST", {}));
    expect(second.status).toBe(409);
    expect((await second.json()).activeJobId).toBe(job.id);
  });

  it("preços/estoque antes do catálogo retornam 409 catalog_empty; ids inválidos retornam 400", async () => {
    expect((await importPrices(send("/api/import/prices", "POST", {}))).status).toBe(409);
    const bad = await importStocks(send("/api/import/stocks", "POST", { adsProductIds: ["x"] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("validation_error");
  });

  it("histórico e detalhe da importação com registros de erro", async () => {
    const data = sampleData();
    data.prices.push(price(123456, "F", 1));
    await seedCatalog(data);
    const list = await (await jobsList(get("/api/import/jobs"))).json();
    expect(list.total).toBe(3);
    const pricesJob = list.items.find((j: { type: string }) => j.type === "PRICES");
    expect(pricesJob.status).toBe("PARTIALLY_COMPLETED");
    const detail = await (await jobDetail(get(`/api/import/jobs/${pricesJob.id}`), ctx({ id: pricesJob.id }))).json();
    expect(detail.errors.items[0]).toMatchObject({ errorCode: "PRODUCT_NOT_IMPORTED", externalProductId: 123456 });
  });
});

describe("catálogo: pesquisa, filtros e paginação no servidor", () => {
  it("pesquisa por nome, ID ADS, código de fabricante e EAN", async () => {
    await seedCatalog();
    const search = async (q: string) => (await (await productsList(get(`/api/products?q=${encodeURIComponent(q)}`))).json()).items.map((i: { adsProductId: number }) => i.adsProductId);
    expect(await search("oxidante")).toEqual([1804]);
    expect(await search("5653")).toEqual([5653]);
    expect(await search("H0269721")).toEqual([1804]);
    expect(await search("7896014106226")).toEqual([1804]);
    expect(await search("100%_")).toEqual([]);
  });

  it("filtros de estoque distinguem positivo, zerado e desconhecido", async () => {
    await seedCatalog();
    const ids = async (qs: string) => (await (await productsList(get(`/api/products?${qs}`))).json()).items.map((i: { adsProductId: number }) => i.adsProductId).sort();
    expect(await ids("stock=positive")).toEqual([5653]);
    expect(await ids("stock=zero")).toEqual([1804]);
    expect(await ids("stock=unknown")).toEqual([7000, 7001]);
    expect(await ids("status=inactive")).toEqual([7000]);
    expect(await ids("supplierId=600")).toEqual([5653]);
    expect(await ids("image=without")).toHaveLength(4);
  });

  it("pagina no servidor e valida parâmetros", async () => {
    await seedCatalog();
    const page = await (await productsList(get("/api/products?pageSize=3&page=2&sort=ads_id"))).json();
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 3 });
    expect(page.items.map((i: { adsProductId: number }) => i.adsProductId)).toEqual([7001]);
    expect((await productsList(get("/api/products?stock=talvez"))).status).toBe(400);
  });
});

describe("tabela de referência e preços", () => {
  it("não assume tabela padrão; rejeita tabela inexistente ou inativa; preço inativo não é sugerido", async () => {
    await seedCatalog();
    let list = await (await productsList(get("/api/products?sort=ads_id"))).json();
    expect(list.settings.defaultPriceTable).toBeNull();
    expect(list.items[0].referencePrice).toBeNull();

    expect((await setDefaultTable(send("/api/settings/default-price-table", "PATCH", { code: "Z" }))).status).toBe(422);
    expect((await setDefaultTable(send("/api/settings/default-price-table", "PATCH", { code: "H" }))).status).toBe(422);
    expect((await setDefaultTable(send("/api/settings/default-price-table", "PATCH", { code: "F" }))).status).toBe(200);

    list = await (await productsList(get("/api/products?sort=ads_id"))).json();
    const byId = Object.fromEntries(list.items.map((i: { adsProductId: number; referencePrice: string | null }) => [i.adsProductId, i.referencePrice]));
    expect(byId[1804]).toBe("88.2000");
    expect(byId[5653]).toBeNull(); // preço F inativo
    expect(byId[7001]).toBeNull(); // sem preço = indisponível
    expect((await (await productsList(get("/api/products?price=without"))).json()).total).toBe(3);

    const tables = await (await priceTables(get("/api/price-tables"))).json();
    expect(tables.tables.map((x: { code: string }) => x.code)).toEqual(["F", "G", "H", "U"]);
    expect(tables.branches).toEqual(["01"]);
  });

  it("detalhe do produto expõe todas as tabelas e o estoque por filial", async () => {
    await seedCatalog();
    const id = await idOf(5653);
    const prices = await (await productPrices(get(`/api/products/${id}/prices`), ctx({ id: String(id) }))).json();
    expect(prices.prices.map((p: { priceTableCode: string; inactive: boolean }) => [p.priceTableCode, p.inactive])).toEqual([
      ["F", true],
      ["G", false],
    ]);
    const stockRes = await (await productStock(get(`/api/products/${id}/stock`), ctx({ id: String(id) }))).json();
    expect(stockRes.status).toBe("positive");
    expect(stockRes.stocks[0]).toMatchObject({ branchId: "01", quantity: "3.000" });

    const unknownId = await idOf(7001);
    expect((await (await productStock(get(`/api/products/${unknownId}/stock`), ctx({ id: String(unknownId) }))).json()).status).toBe("unknown");
    expect((await productGet(get("/api/products/999999"), ctx({ id: "999999" }))).status).toBe(404);
    expect((await productGet(get("/api/products/abc"), ctx({ id: "abc" }))).status).toBe(400);
  });

  it("atualização manual de um produto consulta a ADS só para ele (ids) e atualiza estoque", async () => {
    const data = sampleData();
    const mock = await seedCatalog(data);
    data.stocks[0] = { ...data.stocks[0], estoque: 12 };
    const id = await idOf(1804);
    const before = mock.calls.length;
    const res = await productRefresh(send(`/api/products/${id}/refresh`, "POST", { scopes: ["stock"] }), ctx({ id: String(id) }));
    expect(res.status).toBe(200);
    const newCalls = mock.calls.slice(before);
    expect(newCalls.map((c) => [c.resource, c.ids])).toEqual([["estoques", [1804]]]);
    const stockRes = await (await productStock(get(`/api/products/${id}/stock`), ctx({ id: String(id) }))).json();
    expect(stockRes.stocks[0].quantity).toBe("12.000");
  });
});

describe("edição manual e rascunhos", () => {
  it("nome personalizado é preservado após nova importação da ADS", async () => {
    const data = sampleData();
    await seedCatalog(data);
    const id = await idOf(1804);
    const patched = await productPatch(send(`/api/products/${id}`, "PATCH", { nameCustom: "Oxidante L'Oréal 20 vol 950 ml" }), ctx({ id: String(id) }));
    expect(patched.status).toBe(200);
    expect((await productPatch(send(`/api/products/${id}`, "PATCH", { inactive: false }), ctx({ id: String(id) }))).status).toBe(400);

    data.products[0] = { ...data.products[0], descricao: "LOREAL OXIDANTE NOVA DESCRICAO" };
    await importProducts(send("/api/import/products", "POST", {}));
    await runWorker();
    const detail = await (await productGet(get(`/api/products/${id}`), ctx({ id: String(id) }))).json();
    expect(detail.product).toMatchObject({ nameCustom: "Oxidante L'Oréal 20 vol 950 ml", nameOriginal: "LOREAL OXIDANTE NOVA DESCRICAO" });
  });

  it("cria rascunhos em lote (ignora inativos e duplicados) sem preencher preço/quantidade automaticamente", async () => {
    await seedCatalog();
    await setDefaultTable(send("/api/settings/default-price-table", "PATCH", { code: "F" }));
    const ids = [await idOf(1804), await idOf(7000), await idOf(5653)];
    const res = await draftsCreate(send("/api/listing-drafts", "POST", { productIds: ids }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toHaveLength(2);
    expect(body.skipped).toEqual([{ productId: ids[1], reason: "inactive" }]);

    const again = await (await draftsCreate(send("/api/listing-drafts", "POST", { productId: ids[0] }))).json();
    expect(again.skipped[0].reason).toBe("already_exists");

    const draftId = body.created[0].draftId;
    const draft = await (await draftGet(get(`/api/listing-drafts/${draftId}`), ctx({ id: String(draftId) }))).json();
    expect(draft.draft).toMatchObject({
      title: "LOREAL P OXIDANTE CR 950ML 20VOL",
      selectedPriceTable: "F",
      referencePrice: "88.2000",
      listingPrice: null,
      listingQuantity: null,
      status: "DRAFT",
    });
    expect(draft.readiness.blocking.map((b: { code: string }) => b.code)).toEqual(["PRICE_MISSING", "QUANTITY_MISSING", "NO_IMAGES"]);
    const list = await (await draftsList(get("/api/listing-drafts?status=DRAFT"))).json();
    expect(list.total).toBe(2);
  });

  it("edita e salva o rascunho; READY só com requisitos atendidos (imagem, preço, quantidade)", async () => {
    await seedCatalog();
    const productId = await idOf(1804);
    const { created } = await (await draftsCreate(send("/api/listing-drafts", "POST", { productId }))).json();
    const draftId = String(created[0].draftId);

    const saved = await draftPatch(
      send(`/api/listing-drafts/${draftId}`, "PATCH", {
        title: "Oxidante L'Oréal 20 Volumes 950ml",
        description: "Oxidante cremoso.",
        selectedPriceTable: "G",
        listingPrice: "109,90",
        listingQuantity: 2,
        marketplaceCategoryId: "MLB1234",
        marketplaceAttributes: [{ id: "BRAND", value_name: "L'Oréal" }],
      }),
      ctx({ id: draftId }),
    );
    expect(saved.status).toBe(200);
    const s = await saved.json();
    expect(s.draft).toMatchObject({ listingPrice: "109.90", referencePrice: "99.9000", selectedPriceTable: "G", listingQuantity: 2 });
    expect(s.readiness.warnings.map((w: { code: string }) => w.code)).toContain("QUANTITY_ABOVE_STOCK");

    const notReady = await draftPatch(send(`/api/listing-drafts/${draftId}`, "PATCH", { status: "READY" }), ctx({ id: draftId }));
    expect(notReady.status).toBe(422);
    expect((await notReady.json()).readiness.blocking.map((b: { code: string }) => b.code)).toEqual(["NO_IMAGES"]);
    expect((await (await draftGet(get(`/api/listing-drafts/${draftId}`), ctx({ id: draftId }))).json()).draft.status).toBe("DRAFT");

    await t.sql().execute(
      `INSERT INTO product_images (product_id, storage_path, public_url, content_type, size_bytes, is_primary) VALUES ($1, 'p/1.jpg', 'https://cdn/1.jpg', 'image/jpeg', 1, true)`,
      [productId],
    );
    const ready = await draftPatch(send(`/api/listing-drafts/${draftId}`, "PATCH", { status: "READY" }), ctx({ id: draftId }));
    expect(ready.status).toBe(200);
    expect((await ready.json()).draft.status).toBe("READY");

    // Nada foi enviado ao Mercado Livre.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("mercadolibre") || u.includes("mercadolivre"))).toBe(false);
  });

  it("valida preço e categoria do rascunho", async () => {
    await seedCatalog();
    const { created } = await (await draftsCreate(send("/api/listing-drafts", "POST", { productId: await idOf(1804) }))).json();
    const id = String(created[0].draftId);
    for (const body of [{ listingPrice: "-1" }, { listingPrice: "10,999" }, { listingPrice: "abc" }, { marketplaceCategoryId: "XYZ" }, { status: "PUBLISHED" }]) {
      expect((await draftPatch(send(`/api/listing-drafts/${id}`, "PATCH", body), ctx({ id }))).status).toBe(400);
    }
  });
});
