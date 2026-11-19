import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as automationGet, POST as automationPost } from "@/app/api/nuvemshop/automation/route";
import { POST as catalogPost } from "@/app/api/nuvemshop/catalog/route";
import { POST as eventsPost } from "@/app/api/webhooks/nuvemshop/events/route";
import { InventoryWriteBlockedError } from "@/lib/inventory/mode";
import { NuvemshopInventoryAdapter } from "@/lib/inventory/adapters/nuvemshop";
import {
  activateEmergencyStop,
  AUTOMATIC_CONFIRMATION,
  AutomationError,
  pauseAutomation,
  releaseEmergencyStop,
  resumeAutomation,
  selectedForWrite,
  setAutomationMode,
  setParticipation,
  updateAutomationSettings,
} from "@/lib/nuvemshop/automation";
import { resetNuvemshopThrottleForTests } from "@/lib/nuvemshop/client";
import { processWebhookEvents, recordWebhookEvent, registerWebhooks, setNuvemshopEventProcessorForTesting } from "@/lib/nuvemshop/events";
import { createImportJob, processNuvemshopJobs } from "@/lib/nuvemshop/import";
import { confirmMapping } from "@/lib/nuvemshop/mapping";
import { commitsStock, confirmAdsReflection, orderProtectionState, reconcileOrders, upsertOrder } from "@/lib/nuvemshop/orders";
import { approvePriceReview, computeTargetCents, evaluatePrice, runPriceSync } from "@/lib/nuvemshop/price-sync";
import { addImage, createProductFromAds, createVariant, reconcileUncertainCreate, removeImage, setMainImage, setVisibility, updateProduct, updateVariant } from "@/lib/nuvemshop/products-admin";
import { refreshProducts } from "@/lib/nuvemshop/remote-state";
import { runNuvemshopTick } from "@/lib/nuvemshop/scheduler";
import { evaluateStock, mlLegacyWriters, runStockSync, stockActivationBlockers } from "@/lib/nuvemshop/stock-sync";
import { clientForConnectedStore } from "@/lib/nuvemshop/store";
import { enqueueWrite, processWriteJobs, resolveJobManually, resolveUncertainJobs, WRITER_LEASE } from "@/lib/nuvemshop/write-jobs";
import { handleCallback, startAuthorization } from "@/lib/nuvemshop/oauth";
import { updateStockSettings } from "@/lib/stock/settings";
import { ADS_BASE, price as adsPriceRow, stock as adsStockRow } from "./helpers/ads-mock";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { FakeNuvemshop, NS_SECRET, NS_STORE, nsEnv, type FakeProduct } from "./helpers/nuvemshop-mock";
import { useTestDatabase } from "./helpers/pg";
import { setAdsClockForTesting } from "@/lib/ads/hours";

/**
 * Fase 2 Nuvemshop: produtos/imagens, preço e estoque automáticos (cotas do Inventory Core), proteção de pedidos,
 * webhooks, fila de escritas, modos, pausa e desligamento de emergência. Tudo contra a Nuvemshop SIMULADA.
 */
const t = useTestDatabase();
const sql = () => t.sql();
const ACTOR = "admin:teste";
const noSleep = async () => {};
let ns: FakeNuvemshop;
let adsPrices: Record<string, unknown>[];
/** Saldo ADS ao vivo (GET /estoques); null = ADS fora do ar. */
let adsStocks: Record<string, unknown>[] | null;
/** ADS fora do ar para a tabela de preços (503). */
let adsPricesDown = false;
const deps = () => ({ fetchImpl: ns.fetch as unknown as typeof fetch, sleep: noSleep, maxRetries: 1 });

beforeEach(() => {
  for (const [k, v] of Object.entries(nsEnv())) process.env[k] = v;
  process.env.NUVEMSHOP_WRITE_ENABLED = "true";
  process.env.INVENTORY_CORE_MODE = "shadow";
  resetNuvemshopThrottleForTests();
  setNuvemshopEventProcessorForTesting(() => {});
  ns = new FakeNuvemshop();
  ns.scope = "read_products,write_products,read_orders";
  adsPrices = [];
  adsStocks = null;
  adsPricesDown = false;
  // ADS simulada: só a tabela de preços (o saldo vem do cache product_stocks nos testes).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === ADS_BASE && url.pathname.endsWith("/tabela-precos-itens")) {
        if (adsPricesDown) return new Response(JSON.stringify({ title: "Service Unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
        const ids = url.searchParams.getAll("ids").map(Number);
        const rows = adsPrices.filter((r) => ids.includes(Number(r.produtoId)));
        return new Response(JSON.stringify({ items: rows, page: 1, pageSize: 100, total: rows.length, hasNext: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.origin === ADS_BASE && url.pathname.endsWith("/estoques")) {
        if (!adsStocks) return new Response(JSON.stringify({ title: "Service Unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
        const ids = url.searchParams.getAll("ids").map(Number);
        const rows = adsStocks.filter((r) => ids.includes(Number(r.produtoId)));
        return new Response(JSON.stringify({ items: rows, page: 1, pageSize: 100, total: rows.length, hasNext: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("NUVEMSHOP_")) delete process.env[k];
  delete process.env.INVENTORY_CORE_MODE;
  setNuvemshopEventProcessorForTesting(null);
});

async function connect(): Promise<void> {
  const { authorizationUrl, bindingNonce } = await startAuthorization(sql(), ACTOR);
  const state = new URL(authorizationUrl).searchParams.get("state");
  const r = await handleCallback(sql(), { code: "code-1", state, error: null, bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
  expect(r.ok).toBe(true);
}

async function importAll() {
  await createImportJob(sql(), { mode: "FULL", actor: ACTOR });
  for (let i = 0; i < 30; i++) {
    const r = await processNuvemshopJobs({ sql: sql(), fetchImpl: ns.fetch, sleep: noSleep, retryBaseMs: 1, budgetMs: 60_000 });
    if (!r.more) break;
  }
}

async function adsProduct(ads: number, o: { stock?: number; kit?: boolean } = {}): Promise<number> {
  const [{ id }] = await sql().query<{ id: number }>(
    `INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [ads, `PRODUTO ADS ${ads}`, JSON.stringify({ kit: o.kit ?? false })],
  );
  if (o.stock !== undefined) await setAdsStock(id, ads, o.stock);
  return id;
}

async function setAdsStock(productId: number, ads: number, qty: number) {
  await sql().execute(`DELETE FROM product_stocks WHERE product_id = $1`, [productId]);
  await sql().execute(`INSERT INTO product_stocks (product_id, ads_product_id, branch_id, quantity, raw_payload, fetched_at) VALUES ($1, $2, '01', $3::numeric, '{}'::jsonb, now())`, [productId, ads, String(qty)]);
}

const simple = (id: number, sku: string | null, o: Partial<FakeProduct> & { stock?: number | null; price?: string; promo?: string | null } = {}): FakeProduct => ({
  id,
  name: { pt: `Produto ${id}` },
  images: [{ id: id * 10, src: `https://cdn.test/${id}.jpg`, position: 1 }],
  variants: [{ id: id * 100, sku, stock: o.stock === undefined ? 0 : o.stock, stock_management: true, price: o.price ?? "10.00", promotional_price: o.promo ?? null }],
  ...o,
});

async function policy5050(reserve = 2) {
  await sql().execute(`INSERT INTO inventory_allocation_policies (scope, version, safety_reserve, remainder_mode, rules, created_by)
    VALUES ('GLOBAL', 1, $1, 'PRIORITY', '[{"channel":"mercadolivre","type":"PERCENT","value":50,"priority":1},{"channel":"nuvemshop","type":"PERCENT","value":50,"priority":2}]', 'teste')`, [reserve]);
  await updateStockSettings(sql(), { branchIds: ["01"] }, ACTOR);
}

/** Loja com um produto ADS (saldo `ads`) vinculado à variante 100 (estoque `nsStock`) e a localização LOC-A no depósito principal. */
async function scenario(o: { ads?: number | null; nsStock?: number; price?: string; promo?: string | null } = {}) {
  await connect();
  await policy5050();
  const p = await adsProduct(77, o.ads === null ? {} : { stock: o.ads ?? 10 });
  ns.products = [simple(1, "ADS-77", { stock: o.nsStock ?? 0, price: o.price, promo: o.promo })];
  await importAll();
  await sql().execute(`UPDATE nuvemshop_locations SET mapping_status = 'MAPPED', warehouse_code = 'principal' WHERE location_id = 'LOC-A'`);
  await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: p, actor: ACTOR });
  return p;
}

/** Proteção de pedidos operante: webhooks cadastrados + reconciliação concluída. */
async function protect() {
  const conn = await clientForConnectedStore(sql(), deps());
  await registerWebhooks(sql(), ACTOR, deps());
  await reconcileOrders(sql(), conn.client, NS_STORE);
}

async function pilot(kind: "PRICE" | "STOCK", variantIds = ["100"]) {
  await setAutomationMode(sql(), kind, { mode: "PILOT" }, ACTOR);
  await setParticipation(sql(), { storeId: NS_STORE, kind, variantIds, participation: "PILOT", actor: ACTOR });
}

const stockRun = () => runStockSync(sql(), { trigger: "manual", requestedBy: ACTOR, deps: deps(), adsLive: false });
const priceRun = () => runPriceSync(sql(), { trigger: "manual", requestedBy: ACTOR, deps: deps() });
const writer = () => processWriteJobs(sql(), { deps: deps() });
const nsWrites = () => ns.writes.filter((w) => w.path === "/products/stock-price");
const jobs = () => sql().query<{ id: string; kind: string; status: string; target: string; expected: string | null; errorCode: string | null; mode: string }>(
  `SELECT id::text AS id, kind, status, target_value AS target, expected_value AS expected, error_code AS "errorCode", mode FROM nuvemshop_write_jobs ORDER BY created_at, id`,
);
const items = (runId: string) => sql().query<{ variantId: string; decision: string; reasonCode: string | null; target: string | null; current: string | null }>(
  `SELECT variant_id::text AS "variantId", decision, reason_code AS "reasonCode", target_value AS target, current_value AS current FROM nuvemshop_sync_items WHERE run_id = $1::uuid ORDER BY id`,
  [runId],
);
const reservations = () => sql().query<{ orderId: string; state: string; quantity: string }>(`SELECT external_order_id AS "orderId", state, trim_scale(quantity)::text AS quantity FROM inventory_reservations WHERE channel = 'nuvemshop' ORDER BY id`);
const order = (id: number, o: { qty?: number; variant?: number; status?: string; createdAt?: string; updatedAt?: string; payment?: string } = {}) => ({
  id,
  number: id - 4000,
  status: o.status ?? "open",
  payment_status: o.payment ?? "pending",
  created_at: o.createdAt ?? new Date().toISOString(),
  updated_at: o.updatedAt ?? new Date().toISOString(),
  cancelled_at: o.status === "cancelled" ? new Date().toISOString() : null,
  contact_email: "comprador@exemplo.test",
  contact_name: "Comprador Teste",
  products: [{ id: id * 10, product_id: 1, variant_id: o.variant ?? 100, quantity: o.qty ?? 2, sku: "ADS-77", name: "Produto 1" }],
});

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  return makeRequest("/api/webhooks/nuvemshop/events", { method: "POST", headers: { "x-linkedstore-hmac-sha256": createHmac("sha256", NS_SECRET).update(raw).digest("hex") }, body });
}

// ---------------------------------------------------------------------------
describe("Produtos, variantes e imagens", () => {
  beforeEach(async () => {
    await connect();
  });

  it("cria produto a partir da ADS: oculto, estoque 0 controlado, SKU ADS, vínculo confirmado e releitura; não recria nem duplica SKU", async () => {
    const p = await adsProduct(55);
    const r = await createProductFromAds(sql(), { productId: p, price: 39.9, imageUrls: ["https://cdn.test/a.jpg"] }, ACTOR, deps());
    expect(r).toMatchObject({ verified: true, reconciled: false });
    const created = ns.products.find((x) => String(x.id) === r.nsProductId)!;
    expect(created.visibility).toBe("hidden");
    expect(created.variants![0]).toMatchObject({ sku: "ADS-55", stock: 0, stock_management: true });
    const [m] = await sql().query<{ status: string; productId: number }>(`SELECT status, product_id AS "productId" FROM nuvemshop_variant_mappings WHERE variant_id = $1::bigint`, [r.variantId]);
    expect(m).toEqual({ status: "CONFIRMED", productId: p });
    await expect(createProductFromAds(sql(), { productId: p, price: 10 }, ACTOR, deps())).rejects.toMatchObject({ code: "already_linked" });
    const p2 = await adsProduct(56);
    await expect(createProductFromAds(sql(), { productId: p2, price: 10, sku: "ADS-55" }, ACTOR, deps())).rejects.toMatchObject({ code: "sku_exists" });
    expect(ns.writes.filter((w) => w.method === "POST" && w.path === "/products")).toHaveLength(1);
  });

  it("criação com resultado incerto: aplicada → reconciliada pelo SKU sem duplicar; não aplicada → bloqueia nova tentativa até reconciliar", async () => {
    const a = await adsProduct(60);
    ns.failures.set("/products", ["timeout_applied"]);
    const r = await createProductFromAds(sql(), { productId: a, price: 20 }, ACTOR, deps());
    expect(r.reconciled).toBe(true);
    expect(ns.products).toHaveLength(1);
    const b = await adsProduct(61);
    ns.failures.set("/products", ["timeout"]);
    await expect(createProductFromAds(sql(), { productId: b, price: 20 }, ACTOR, deps())).rejects.toThrow();
    await expect(createProductFromAds(sql(), { productId: b, price: 20 }, ACTOR, deps())).rejects.toMatchObject({ code: "create_in_progress" });
    const [op] = await sql().query<{ id: string }>(`SELECT id::text AS id FROM nuvemshop_product_operations WHERE product_id = $1 AND status = 'UNCERTAIN'`, [b]);
    expect(await reconcileUncertainCreate(sql(), op.id, ACTOR, deps())).toEqual({ found: false, nsProductId: null });
    await createProductFromAds(sql(), { productId: b, price: 20 }, ACTOR, deps());
    expect(ns.products).toHaveLength(2);
  });

  it("edita produto, publica com confirmação, cria/edita variante, gerencia imagens com confirmação de remoção", async () => {
    ns.products = [simple(1, "ADS-1", { images: [{ id: 11, src: "https://cdn.test/1.jpg", position: 1 }, { id: 12, src: "https://cdn.test/2.jpg", position: 2 }] })];
    await importAll();
    expect(await updateProduct(sql(), "1", { name: "Shampoo Novo", brand: "Lopes" }, ACTOR, deps())).toEqual({ verified: true });
    expect(ns.products[0].name).toEqual({ pt: "Shampoo Novo" });
    await expect(setVisibility(sql(), "1", "visible", false, ACTOR, deps())).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await setVisibility(sql(), "1", "hidden", false, ACTOR, deps())).toEqual({ verified: true });
    const ads = await adsProduct(5);
    const v = await createVariant(sql(), "1", { values: ["500 ml"], price: 30, sku: "ADS-5", productId: ads }, ACTOR, deps());
    expect(v.linked).toBe(true);
    expect(await updateVariant(sql(), "1", v.variantId, { price: 31.5 }, ACTOR, deps())).toEqual({ verified: true });
    // Preço controlado pela automação: edição manual recusada.
    await setAutomationMode(sql(), "PRICE", { mode: "PILOT" }, ACTOR);
    await setParticipation(sql(), { storeId: NS_STORE, kind: "PRICE", variantIds: [v.variantId], participation: "PILOT", actor: ACTOR });
    await expect(updateVariant(sql(), "1", v.variantId, { price: 40 }, ACTOR, deps())).rejects.toMatchObject({ code: "price_automated" });
    const img = await addImage(sql(), "1", { src: "https://cdn.test/novo.jpg" }, ACTOR, deps());
    expect(img.verified).toBe(true);
    expect(await setMainImage(sql(), "1", "12", ACTOR, deps())).toEqual({ verified: true });
    await expect(removeImage(sql(), "1", "11", null, ACTOR, deps())).rejects.toMatchObject({ code: "confirmation_required" });
    expect(await removeImage(sql(), "1", "11", "11", ACTOR, deps())).toEqual({ verified: true });
    expect(ns.writes.some((w) => w.method === "PUT" && /\/variants$/.test(w.path))).toBe(false); // nunca a coleção de variantes
    const [{ n }] = await sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM nuvemshop_product_operations WHERE status = 'SUCCEEDED'`);
    expect(n).toBeGreaterThanOrEqual(7);
  });

  it("ID de variante alterado na loja (variante recriada): a antiga fica REMOVED e o vínculo vai para revisão", async () => {
    const ads = await adsProduct(1);
    ns.products = [simple(1, "ADS-1")];
    await importAll();
    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: ads, actor: ACTOR });
    ns.products[0].variants = [{ id: 101, sku: "ADS-1", stock: 3 }];
    const conn = await clientForConnectedStore(sql(), deps());
    await refreshProducts(sql(), conn.client, NS_STORE, ["1"]);
    const [old] = await sql().query<{ status: string }>(`SELECT sync_status AS status FROM nuvemshop_variants WHERE variant_id = 100`);
    expect(old.status).toBe("REMOVED");
    const [m] = await sql().query<{ status: string }>(`SELECT status FROM nuvemshop_variant_mappings WHERE variant_id = 100 AND status IN ('CONFIRMED', 'NEEDS_REVIEW')`);
    expect(m?.status).toBe("NEEDS_REVIEW");
  });

  it("rota de criação exige administrador e mesma origem", async () => {
    expect((await catalogPost(makeRequest("/api/nuvemshop/catalog", { method: "POST", body: { productId: 1, price: 1 } }))).status).toBe(401);
    expect((await catalogPost(makeRequest("/api/nuvemshop/catalog", { method: "POST", cookies: adminCookies(), body: { productId: 1, price: 1 } }))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("Preço automático (regras puras)", () => {
  const policy = { priceTableCode: "M", branchId: null, marginPct: 0, minPrice: null, rounding: "NONE" as const, promotion: "BLOCK" as const, maxChangePct: 20, cacheMaxAgeHours: 48 };
  const remote = (price: string | null, promo: string | null = null) => ({ storeId: NS_STORE, productId: "1", variantId: "100", price, promotionalPrice: promo, stockManagement: true, stock: 1, levels: null, sku: "x", updatedAt: null, removed: false, readAt: new Date() });
  const known = (p: string) => ({ status: "KNOWN" as const, price: p, branchId: "01", updatedAt: null });

  it("margem, arredondamento e mínimo", () => {
    expect(computeTargetCents(2550, { marginPct: 10, rounding: "CENTS_90", minPrice: null })).toBe(2890);
    expect(computeTargetCents(2000, { marginPct: 0, rounding: "CENTS_99", minPrice: null })).toBe(2099);
    expect(computeTargetCents(1001, { marginPct: 0, rounding: "WHOLE", minPrice: null })).toBe(1100);
    expect(computeTargetCents(500, { marginPct: 0, rounding: "NONE", minPrice: 9.9 })).toBe(990);
  });

  it("decisões: igual, escrever, promoção (BLOCK/KEEP), variação grande, sem preço atual, ADS desconhecida/zero/erro, kit", () => {
    expect(evaluatePrice({ ads: known("10.00"), remote: remote("10.00"), kit: false, policy }).decision).toBe("IN_SYNC");
    expect(evaluatePrice({ ads: known("11.00"), remote: remote("10.00"), kit: false, policy })).toMatchObject({ decision: "WRITE", targetCents: 1100, changePct: 10 });
    expect(evaluatePrice({ ads: known("11.00"), remote: remote("10.00", "8.00"), kit: false, policy }).reasonCode).toBe("PROMOTION_ACTIVE");
    expect(evaluatePrice({ ads: known("11.00"), remote: remote("10.00", "8.00"), kit: false, policy: { ...policy, promotion: "KEEP" } }).decision).toBe("WRITE");
    expect(evaluatePrice({ ads: known("7.00"), remote: remote("10.00", "8.00"), kit: false, policy: { ...policy, promotion: "KEEP", maxChangePct: 90 } }).reasonCode).toBe("PROMOTION_ABOVE_PRICE");
    expect(evaluatePrice({ ads: known("20.00"), remote: remote("10.00"), kit: false, policy })).toMatchObject({ decision: "REVIEW", reasonCode: "LARGE_CHANGE" });
    expect(evaluatePrice({ ads: known("20.00"), remote: remote(null), kit: false, policy }).reasonCode).toBe("NO_CURRENT_PRICE");
    expect(evaluatePrice({ ads: { status: "UNKNOWN", price: null, branchId: null, updatedAt: null }, remote: remote("10.00"), kit: false, policy }).reasonCode).toBe("ADS_PRICE_UNKNOWN");
    expect(evaluatePrice({ ads: known("0"), remote: remote("10.00"), kit: false, policy }).reasonCode).toBe("ADS_PRICE_ZERO");
    expect(evaluatePrice({ ads: { status: "ERROR", price: null, branchId: null, updatedAt: null, error: "fora" }, remote: remote("10.00"), kit: false, policy }).reasonCode).toBe("ADS_ERROR");
    expect(evaluatePrice({ ads: known("11.00"), remote: remote("10.00"), kit: true, policy }).reasonCode).toBe("KIT");
    // Preço do banco: dentro do limite de idade vale; desatualizado nunca é aplicado.
    expect(evaluatePrice({ ads: known("11.00"), remote: remote("10.00"), kit: false, policy, source: { source: "CACHE", fetchedAt: "2026-11-19T10:00:00Z", stale: false } }).decision).toBe("WRITE");
    expect(evaluatePrice({ ads: known("11.00"), remote: remote("10.00"), kit: false, policy, source: { source: "CACHE", fetchedAt: "2026-11-10T10:00:00Z", stale: true } })).toMatchObject({ decision: "BLOCKED", reasonCode: "ADS_PRICE_STALE" });
  });
});

describe("Preço automático (fluxo)", () => {
  beforeEach(async () => {
    await scenario({ price: "27.00" });
    // A ADS tem preço nas duas tabelas: F (Nuvemshop) e M (Mercado Livre). A Nuvemshop usa a F por padrão.
    adsPrices.push(adsPriceRow(77, "F", 25.5), adsPriceRow(77, "M", 99));
    const a = await (await import("@/lib/nuvemshop/automation")).getAutomation(sql(), "PRICE");
    await updateAutomationSettings(sql(), "PRICE", { expectedVersion: a.version, policy: { marginPct: 10, rounding: "CENTS_90" } }, ACTOR);
  });

  it("tabela da Nuvemshop é a F por padrão, independente da tabela M do Mercado Livre", async () => {
    const { getAutomation } = await import("@/lib/nuvemshop/automation");
    const { getPriceSettings } = await import("@/lib/stock/prices");
    expect((await getAutomation(sql(), "PRICE")).policy.priceTableCode).toBe("F");
    expect((await getPriceSettings(sql())).priceTableCode).toBe("M");
    await setAutomationMode(sql(), "PRICE", { mode: "SHADOW" }, ACTOR);
    const r = await priceRun();
    // 25,50 (tabela F) + 10% = 28,05 → 28,90; a tabela M (99,00) não é usada.
    expect((await items(r.runId!))[0]).toMatchObject({ target: "2890" });
    const [base] = await sql().query<{ base: string }>(`SELECT base_value AS base FROM nuvemshop_sync_items WHERE run_id = $1::uuid`, [r.runId]);
    expect(base.base).toBe("2550");
    // O cache de preços guarda cada tabela separada, com o valor da ADS: a M do ML não é alterada pela F.
    const rows = await sql().query<{ table: string; price: string }>(`SELECT price_table_code AS table, trim_scale(price)::text AS price FROM product_prices ORDER BY 1`);
    expect(rows).toEqual([{ table: "F", price: "25.5" }, { table: "M", price: "99" }]);
    expect((await getPriceSettings(sql())).priceTableCode).toBe("M");
  });

  it("ADS desligada: usa o preço da tabela F já gravado no sistema (sem consultar a ADS); desatualizado é bloqueado; ADS com falha no horário cai no banco", async () => {
    const [{ id: p }] = await sql().query<{ id: number }>(`SELECT id FROM products WHERE ads_product_id = 77`);
    await sql().execute(
      `INSERT INTO product_prices (product_id, ads_product_id, branch_id, price_table_code, price, raw_payload, fetched_at) VALUES ($1, 77, '01', 'F', 25.5, '{}'::jsonb, now() - interval '2 hours'),
         ($1, 77, '01', 'M', 99, '{}'::jsonb, now() - interval '2 hours')`,
      [p],
    );
    // 22h em Campo Grande: ADS fora do horário.
    setAdsClockForTesting(() => new Date("2026-11-13T02:00:00Z"));
    await pilot("PRICE");
    const adsCalls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes("tabela-precos")).length;
    const before = adsCalls();
    const r = await priceRun();
    expect(adsCalls()).toBe(before);
    expect(r.status).toBe("COMPLETED");
    expect((await items(r.runId!))[0]).toMatchObject({ decision: "WRITE", target: "2890" });
    const [d] = await sql().query<{ details: { priceSource: string } }>(`SELECT details FROM nuvemshop_sync_items WHERE run_id = $1::uuid`, [r.runId]);
    expect(d.details.priceSource).toBe("CACHE");
    await writer();
    expect(ns.variant(100)!.price).toBe("28.90");
    // Preço gravado há mais que o limite (48 h): não aplicado.
    ns.variant(100)!.price = "27.00";
    await sql().execute(`UPDATE product_prices SET fetched_at = now() - interval '3 days'`);
    const stale = await priceRun();
    expect((await items(stale.runId!))[0]).toMatchObject({ decision: "BLOCKED", reasonCode: "ADS_PRICE_STALE" });
    await writer();
    expect(ns.variant(100)!.price).toBe("27.00");
    // No horário, com a ADS fora do ar: usa o banco (se estiver dentro do limite).
    await sql().execute(`UPDATE product_prices SET fetched_at = now() - interval '1 hour'`);
    setAdsClockForTesting(() => new Date("2026-11-12T16:00:00Z"));
    adsPricesDown = true;
    const fallback = await priceRun();
    const [f] = await sql().query<{ details: { priceSource: string }; decision: string }>(`SELECT details, decision FROM nuvemshop_sync_items WHERE run_id = $1::uuid`, [fallback.runId]);
    expect(f).toMatchObject({ decision: "WRITE", details: { priceSource: "CACHE" } });
  });

  it("SHADOW não escreve; PILOT escreve só no piloto, relê e confirma; nova execução fica em sincronia", async () => {
    await setAutomationMode(sql(), "PRICE", { mode: "SHADOW" }, ACTOR);
    const s = await priceRun();
    expect((await items(s.runId!))[0]).toMatchObject({ decision: "SHADOW", target: "2890", current: "2700" });
    await writer();
    expect(nsWrites()).toHaveLength(0);
    await setAutomationMode(sql(), "PRICE", { mode: "PILOT" }, ACTOR);
    expect((await items((await priceRun()).runId!))[0].decision).toBe("NOT_SELECTED");
    await setParticipation(sql(), { storeId: NS_STORE, kind: "PRICE", variantIds: ["100"], participation: "PILOT", actor: ACTOR });
    await priceRun();
    const w = await writer();
    expect(w).toMatchObject({ succeeded: 1 });
    expect(ns.variant(100)!.price).toBe("28.90");
    expect(nsWrites()[0].body).toEqual([{ id: 1, variants: [{ id: 100, price: 28.9 }] }]);
    const [j] = await jobs();
    expect(j).toMatchObject({ status: "SUCCEEDED", target: "2890", expected: "2700" });
    expect((await items((await priceRun()).runId!))[0].decision).toBe("IN_SYNC");
  });

  it("mudança expressiva vai para revisão; aprovação cria escrita manual verificada", async () => {
    ns.variant(100)!.price = "10.00";
    await pilot("PRICE");
    const r = await priceRun();
    const [it] = await sql().query<{ id: string; decision: string }>(`SELECT id::text AS id, decision FROM nuvemshop_sync_items WHERE run_id = $1::uuid`, [r.runId]);
    expect(it.decision).toBe("REVIEW");
    await writer();
    expect(nsWrites()).toHaveLength(0);
    await approvePriceReview(sql(), it.id, ACTOR);
    await writer();
    expect(ns.variant(100)!.price).toBe("28.90");
    await expect(approvePriceReview(sql(), it.id, ACTOR)).rejects.toMatchObject({ code: "not_reviewable" });
  });

  it("tabela ADS incorreta: nada é escrito (preço desconhecido nunca vira zero)", async () => {
    const a = await (await import("@/lib/nuvemshop/automation")).getAutomation(sql(), "PRICE");
    await updateAutomationSettings(sql(), "PRICE", { expectedVersion: a.version, policy: { priceTableCode: "Z" } }, ACTOR);
    await pilot("PRICE");
    const r = await priceRun();
    expect((await items(r.runId!))[0]).toMatchObject({ decision: "BLOCKED", reasonCode: "ADS_PRICE_UNKNOWN" });
    expect(await jobs()).toHaveLength(0);
  });

  it("falha parcial e retentativa: lote recusado é isolado por variante; 5xx em preço (idempotente) repete; success:false não é aplicado", async () => {
    ns.products.push(simple(2, "ADS-78", { price: "27.00" }));
    const p2 = await adsProduct(78);
    adsPrices.push(adsPriceRow(78, "F", 25.5));
    const conn = await clientForConnectedStore(sql(), deps());
    await refreshProducts(sql(), conn.client, NS_STORE, ["2"]);
    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "200", productId: p2, actor: ACTOR });
    await pilot("PRICE", ["100", "200"]);
    await priceRun();
    ns.failures.set("/products/stock-price", [422]);
    ns.rejectVariants.add(200);
    await writer();
    const js = await jobs();
    expect(js.find((j) => j.status === "SUCCEEDED")).toBeTruthy();
    expect(js.find((j) => j.status === "FAILED")).toMatchObject({ errorCode: "NOT_APPLIED" });
    expect(ns.variant(100)!.price).toBe("28.90");
    expect(ns.variant(200)!.price).toBe("27.00");
    // Repetição segura: 5xx em escrita de preço (valor absoluto) é repetida até confirmar.
    ns.rejectVariants.clear();
    ns.variant(200)!.price = "27.00";
    await sql().execute(`UPDATE nuvemshop_sync_variants SET evaluated_at = NULL`);
    await priceRun();
    ns.failures.set("/products/stock-price", [500]);
    await writer();
    expect(ns.variant(200)!.price).toBe("28.90");
  });

  it("desativar/pausar cancela escritas não iniciadas e o worker não escreve", async () => {
    await pilot("PRICE");
    await priceRun();
    await pauseAutomation(sql(), "PRICE", ACTOR, "teste");
    await writer();
    expect(nsWrites()).toHaveLength(0);
    expect((await jobs())[0].status).toBe("CANCELED");
    await resumeAutomation(sql(), "PRICE", ACTOR);
    await setAutomationMode(sql(), "PRICE", { mode: "DISABLED" }, ACTOR);
    expect((await priceRun()).status).toBe("SKIPPED");
  });
});

// ---------------------------------------------------------------------------
describe("Estoque automático (regras puras)", () => {
  const remote = (stock: number | null, managed: boolean | null = true) => ({ storeId: NS_STORE, productId: "1", variantId: "100", price: "1", promotionalPrice: null, stockManagement: managed, stock, levels: null, sku: "x", updatedAt: null, removed: false, readAt: new Date() });
  const loc = { locationId: "LOC-A", problem: null };
  const prop = (target: number | null, o: Partial<{ allowIncrease: boolean; ruleZero: boolean; reasonCode: string }> = {}) => ({ target, reasonCode: o.reasonCode ?? null, reason: null, allowIncrease: o.allowIncrease ?? true, ruleZero: o.ruleZero ?? false, reliability: "RELIABLE", productIds: [1] });

  it("desconhecido nunca vira zero; sem controle; sem localização; política zero; reduções sempre; aumentos só sem trava", () => {
    expect(evaluateStock({ remote: undefined, location: loc, proposal: prop(3), increaseBlockers: [] }).reasonCode).toBe("REMOTE_UNKNOWN");
    expect(evaluateStock({ remote: remote(null), location: loc, proposal: prop(3), increaseBlockers: [] }).reasonCode).toBe("REMOTE_UNKNOWN");
    expect(evaluateStock({ remote: remote(5, false), location: loc, proposal: prop(3), increaseBlockers: [] }).reasonCode).toBe("UNMANAGED");
    expect(evaluateStock({ remote: remote(5), location: { locationId: null, problem: { code: "NO_LOCATION", reason: "x" } }, proposal: prop(3), increaseBlockers: [] }).reasonCode).toBe("NO_LOCATION");
    expect(evaluateStock({ remote: remote(5), location: loc, proposal: prop(3, { ruleZero: true }), increaseBlockers: [] }).reasonCode).toBe("POLICY_ZERO");
    expect(evaluateStock({ remote: remote(5), location: loc, proposal: prop(null, { reasonCode: "STOCK_UNKNOWN" }), increaseBlockers: [] })).toMatchObject({ decision: "BLOCKED", reasonCode: "STOCK_UNKNOWN" });
    expect(evaluateStock({ remote: remote(5), location: loc, proposal: undefined, increaseBlockers: [] }).reasonCode).toBe("NO_QUOTA");
    expect(evaluateStock({ remote: remote(5), location: loc, proposal: prop(5), increaseBlockers: [] }).decision).toBe("IN_SYNC");
    expect(evaluateStock({ remote: remote(5), location: loc, proposal: prop(2), increaseBlockers: ["ML"] })).toMatchObject({ decision: "WRITE", target: 2 });
    expect(evaluateStock({ remote: remote(2), location: loc, proposal: prop(5), increaseBlockers: ["estoque no Mercado Livre controlado pelo sincronizador atual"] })).toMatchObject({ decision: "BLOCKED", reasonCode: "INCREASE_BLOCKED" });
    expect(evaluateStock({ remote: remote(2), location: loc, proposal: prop(5, { allowIncrease: false }), increaseBlockers: [] }).reasonCode).toBe("INCREASE_BLOCKED");
    expect(evaluateStock({ remote: remote(2), location: loc, proposal: prop(5), increaseBlockers: [] })).toMatchObject({ decision: "WRITE", target: 5 });
  });

  it("seleção por modo: SHADOW/PAUSED nunca; PILOT só piloto; AUTOMATIC selecionadas ou todas as elegíveis; EXCLUDED nunca", () => {
    expect(selectedForWrite("SHADOW", "ALL_ELIGIBLE", "PILOT")).toBe(false);
    expect(selectedForWrite("PAUSED", "ALL_ELIGIBLE", "PILOT")).toBe(false);
    expect(selectedForWrite("PILOT", "SELECTED", "INCLUDED")).toBe(false);
    expect(selectedForWrite("PILOT", "SELECTED", "PILOT")).toBe(true);
    expect(selectedForWrite("AUTOMATIC", "SELECTED", "NONE")).toBe(false);
    expect(selectedForWrite("AUTOMATIC", "SELECTED", "INCLUDED")).toBe(true);
    expect(selectedForWrite("AUTOMATIC", "ALL_ELIGIBLE", "NONE")).toBe(true);
    expect(selectedForWrite("AUTOMATIC", "ALL_ELIGIBLE", "EXCLUDED")).toBe(false);
  });

  it("pedido: compromete na criação (padrão) ou no pagamento; cancelado nunca", () => {
    expect(commitsStock({ status: "open", payment_status: "pending" }, "CREATED")).toEqual({ commit: true, cancelled: false });
    expect(commitsStock({ status: "open", payment_status: "pending" }, "PAID")).toEqual({ commit: false, cancelled: false });
    expect(commitsStock({ status: "open", payment_status: "paid" }, "PAID")).toEqual({ commit: true, cancelled: false });
    expect(commitsStock({ status: "cancelled", payment_status: "paid" }, "CREATED")).toEqual({ commit: false, cancelled: true });
  });
});

describe("Estoque automático (fluxo com Inventory Core)", () => {
  it("saldo positivo: ADS 10, reserva 2 → Nuvemshop 4 pela cota do Inventory Core; escrita verificada; nova execução não escreve de novo (sem loop)", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    const r = await stockRun();
    expect((await items(r.runId!))[0]).toMatchObject({ decision: "WRITE", current: "0", target: "4" });
    expect(await writer()).toMatchObject({ succeeded: 1 });
    expect(ns.stockOf(100)).toBe(4);
    expect(nsWrites()[0].body).toEqual([{ id: 1, variants: [{ id: 100, inventory_levels: [{ stock: 4 }] }] }]);
    const [alloc] = await sql().query<{ desired: number; simulated: boolean }>(`SELECT desired_quantity AS desired, simulated FROM inventory_channel_allocations WHERE channel = 'nuvemshop'`);
    expect(alloc).toEqual({ desired: 4, simulated: false });
    // Webhook product/updated da nossa escrita: eco, não gera escrita.
    await recordWebhookEvent(sql(), "{}", { store_id: NS_STORE, event: "product/updated", id: 1, event_launch_ts: 1 });
    await processWebhookEvents(sql(), { deps: deps() });
    const [sv] = await sql().query<{ origin: string }>(`SELECT last_origin AS origin FROM nuvemshop_sync_variants WHERE variant_id = 100 AND kind = 'STOCK'`);
    expect(sv.origin).toBe("INTEGRATOR_ECHO");
    expect((await items((await stockRun()).runId!))[0].decision).toBe("IN_SYNC");
    await writer();
    expect(nsWrites()).toHaveLength(1);
  });

  it("saldo zero reduz; estoque ADS desconhecido não escreve; ADS indisponível (sem saldo) não vira zero", async () => {
    const p = await scenario({ ads: 0, nsStock: 3 });
    await protect();
    await pilot("STOCK");
    await stockRun();
    await writer();
    expect(ns.stockOf(100)).toBe(0);
    await sql().execute(`DELETE FROM product_stocks WHERE product_id = $1`, [p]);
    ns.variant(100)!.stock = 2;
    const r = await stockRun();
    expect((await items(r.runId!))[0]).toMatchObject({ decision: "BLOCKED" });
    await writer();
    expect(ns.stockOf(100)).toBe(2);
  });

  it("aumento bloqueado sem proteção de pedidos; redução continua permitida; ativação do piloto exige a proteção", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    expect((await stockActivationBlockers(sql())).join(" ")).toMatch(/Proteção de pedidos/);
    await pilot("STOCK");
    const r = await stockRun();
    expect((await items(r.runId!))[0]).toMatchObject({ decision: "BLOCKED", reasonCode: "INCREASE_BLOCKED" });
    ns.variant(100)!.stock = 9;
    await stockRun();
    await writer();
    expect(ns.stockOf(100)).toBe(4);
    await protect();
    expect(await stockActivationBlockers(sql())).toEqual([]);
  });

  it("pedido pendente: webhook → compromisso no Inventory Core; baixa ADS confirmada libera sem baixa dupla; cancelamento libera; sem dados pessoais", async () => {
    const p = await scenario({ ads: 10, nsStock: 4 });
    await protect();
    await pilot("STOCK");
    ns.orders.push(order(5001, { qty: 2 }));
    ns.sell(100, 2);
    const res = await eventsPost(signed({ store_id: Number(NS_STORE), event: "order/created", id: 5001 }));
    expect(res.status).toBe(200);
    expect((await eventsPost(signed({ store_id: Number(NS_STORE), event: "order/created", id: 5001 }))).status).toBe(200); // duplicado
    await processWebhookEvents(sql(), { deps: deps() });
    expect(await reservations()).toEqual([{ orderId: "5001", state: "PENDING_ERP", quantity: "2" }]);
    const [stored] = await sql().query<{ raw: string }>(`SELECT row_to_json(o)::text AS raw FROM nuvemshop_orders o`);
    expect(stored.raw).not.toMatch(/comprador|Comprador/);
    // ADS 10 − 2 pendentes − 2 reserva = 6 → ML 3 + Nuvemshop 3 (Nuvemshop já mostra 2 após a venda).
    let r = await stockRun();
    expect((await items(r.runId!))[0]).toMatchObject({ current: "2", target: "3" });
    await writer();
    expect(ns.stockOf(100)).toBe(3);
    // Venda sem baixa confirmada além do prazo: aumento bloqueado.
    await sql().execute(`UPDATE inventory_reservations SET order_created_at = now() - interval '3 days'`);
    ns.variant(100)!.stock = 1;
    r = await stockRun();
    expect((await items(r.runId!))[0]).toMatchObject({ decision: "BLOCKED", reasonCode: "INCREASE_BLOCKED" });
    // A ADS baixou (saldo 8) e o administrador confirma: o compromisso deixa de ser descontado (sem baixa dupla).
    await setAdsStock(p, 77, 8);
    await confirmAdsReflection(sql(), { storeId: NS_STORE, orderId: "5001", actor: ACTOR, reference: "ADS-123" });
    expect((await reservations())[0].state).toBe("REFLECTED_IN_ERP");
    r = await stockRun();
    expect((await items(r.runId!))[0]).toMatchObject({ current: "1", target: "3" }); // 8 − 0 − 2 = 6 → 3
    // Cancelamento de outro pedido: liberado.
    ns.orders.push(order(5002, { qty: 1 }));
    const conn = await clientForConnectedStore(sql(), deps());
    await upsertOrder(sql(), NS_STORE, ns.orders[1], "WEBHOOK");
    await upsertOrder(sql(), NS_STORE, { ...ns.orders[1], status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 5000).toISOString() }, "WEBHOOK");
    expect((await reservations()).find((x) => x.orderId === "5002")!.state).toBe("RELEASED");
    // Leitura antiga não volta o pedido.
    expect((await upsertOrder(sql(), NS_STORE, ns.orders[1], "RECONCILIATION")).stale).toBe(true);
    expect(conn.store.storeId).toBe(NS_STORE);
  });

  it("webhook exige assinatura; pedido com variante sem vínculo bloqueia aumentos do produto", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    expect((await eventsPost(makeRequest("/api/webhooks/nuvemshop/events", { method: "POST", body: { store_id: 1, event: "order/created", id: 1 } }))).status).toBe(401);
    ns.products[0].variants!.push({ id: 101, sku: null, stock: 5 });
    ns.orders.push({ ...order(5003, { variant: 101 }) });
    await upsertOrder(sql(), NS_STORE, ns.orders[0], "WEBHOOK");
    const r = await stockRun();
    expect((await items(r.runId!)).find((i) => i.variantId === "100")).toMatchObject({ decision: "BLOCKED", reasonCode: "INCREASE_BLOCKED" });
  });

  it("vendas concorrentes: venda entre o cálculo e a escrita → SUPERSEDED (compare-and-set), nada sobrescreve a venda", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    await stockRun();
    ns.variant(100)!.stock = 0;
    ns.variant(100)!.stock = 1; // ajuste externo
    await writer();
    expect((await jobs())[0]).toMatchObject({ status: "SUPERSEDED", errorCode: "REMOTE_CHANGED" });
    expect(nsWrites()).toHaveLength(0);
    const [sv] = await sql().query<{ dirty: Date | null }>(`SELECT dirty_at AS dirty FROM nuvemshop_sync_variants WHERE variant_id = 100 AND kind = 'STOCK'`);
    expect(sv.dirty).not.toBeNull();
    // Venda logo depois da escrita: aplicado, leitura menor → sucesso não verificado e variante marcada para reavaliação.
    await stockRun();
    ns.afterWrite = () => ns.sell(100, 1);
    await writer();
    expect((await jobs())[1]).toMatchObject({ status: "SUCCEEDED" });
  });

  it("timeout: não aplicado → liberado; aplicado → confirmado; valor inesperado → reconciliação trava a variante até decisão administrativa", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    await stockRun();
    ns.failures.set("/products/stock-price", ["timeout"]);
    await writer();
    expect((await jobs())[0].status).toBe("UNCERTAIN");
    expect(ns.calls.filter((c) => c.method === "PATCH")).toHaveLength(1); // estoque não é repetido às cegas
    await sql().execute(`UPDATE nuvemshop_write_jobs SET updated_at = now() - interval '1 minute'`);
    await resolveUncertainJobs(sql(), deps());
    expect((await jobs())[0]).toMatchObject({ status: "FAILED", errorCode: "NOT_APPLIED" });
    await stockRun();
    ns.failures.set("/products/stock-price", ["timeout_applied"]);
    await writer();
    await sql().execute(`UPDATE nuvemshop_write_jobs SET updated_at = now() - interval '1 minute'`);
    await resolveUncertainJobs(sql(), deps());
    expect((await jobs())[1].status).toBe("SUCCEEDED");
    expect(ns.stockOf(100)).toBe(4);
    ns.variant(100)!.stock = 0;
    await stockRun();
    ns.failures.set("/products/stock-price", ["timeout"]);
    await writer();
    ns.variant(100)!.stock = 7; // nem o anterior nem o alvo
    await sql().execute(`UPDATE nuvemshop_write_jobs SET updated_at = now() - interval '1 minute'`);
    await resolveUncertainJobs(sql(), deps());
    const blocked = (await jobs())[2];
    expect(blocked.status).toBe("REQUIRES_RECONCILIATION");
    const again = await stockRun();
    expect((await items(again.runId!))[0]).toMatchObject({ decision: "BLOCKED", reasonCode: "ACTIVE_JOB" });
    await resolveJobManually(sql(), blocked.id, ACTOR, "conferido na loja");
    await stockRun();
    expect((await jobs()).at(-1)!.status).toBe("PENDING");
  });

  it("multidepósito: escreve só na localização associada (com location_id); duas localizações no mesmo depósito bloqueiam", async () => {
    await connect();
    await policy5050();
    const p = await adsProduct(77, { stock: 10 });
    ns.locations = [{ id: "LOC-A", name: { pt_BR: "A" }, is_default: true }, { id: "LOC-B", name: { pt_BR: "B" } }];
    ns.products = [{ id: 1, name: { pt: "Multi" }, variants: [{ id: 100, sku: "ADS-77", stock: 3, inventory_levels: [{ location_id: "LOC-A", stock: 0 }, { location_id: "LOC-B", stock: 3 }] }] }];
    await importAll();
    await sql().execute(`UPDATE nuvemshop_locations SET mapping_status = 'MAPPED', warehouse_code = 'principal' WHERE location_id = 'LOC-A'`);
    await sql().execute(`UPDATE nuvemshop_locations SET mapping_status = 'EXCLUDED' WHERE location_id = 'LOC-B'`);
    await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: p, actor: ACTOR });
    await protect();
    await pilot("STOCK");
    await stockRun();
    await writer();
    expect(nsWrites()[0].body).toEqual([{ id: 1, variants: [{ id: 100, inventory_levels: [{ location_id: "LOC-A", stock: 4 }] }] }]);
    expect(ns.stockOf(100, "LOC-B")).toBe(3);
    await sql().execute(`UPDATE nuvemshop_locations SET mapping_status = 'MAPPED', warehouse_code = 'principal' WHERE location_id = 'LOC-B'`);
    const r = await stockRun();
    expect((await items(r.runId!))[0].reasonCode).toBe("MULTIPLE_LOCATIONS");
  });

  it("atualização duplicada e concorrência entre workers: um job ativo por variante×localização; um worker por vez; uma execução por vez", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    await stockRun();
    const dup = await enqueueWrite(sql(), { kind: "STOCK", storeId: NS_STORE, nsProductId: "1", variantId: "100", locationId: "LOC-A", expected: "0", target: "9", mode: "MANUAL", runId: null, createdBy: ACTOR });
    expect(dup).toMatchObject({ created: false, reason: "ACTIVE_JOB" });
    await sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ($1, 'outro', now() + interval '1 minute')`, [WRITER_LEASE]);
    expect(await writer()).toMatchObject({ busy: true });
    await sql().execute(`DELETE FROM worker_leases`);
    const [a, b] = await Promise.all([writer(), writer()]);
    expect([a.busy, b.busy].filter(Boolean)).toHaveLength(1);
    expect(nsWrites()).toHaveLength(1);
    await sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ('nuvemshop-stock-sync', 'outro', now() + interval '1 minute')`);
    expect((await stockRun()).status).toBe("BUSY");
  });

  it("Mercado Livre: sem automação do sincronizador atual não há escritor concorrente; Inventory Core segue sem escrita remota", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    expect((await mlLegacyWriters(sql(), [1, 2, 3])).size).toBe(0);
    const adapter = new NuvemshopInventoryAdapter(sql(), "principal");
    const [l] = await adapter.getChannelInventory();
    await expect(adapter.applyStockUpdate(adapter.prepareStockUpdate(l, 1))).rejects.toThrow(InventoryWriteBlockedError);
  });

  it("Inventory Core com automação Nuvemshop desligada: canal continua simulado (comportamento da Fase 1)", async () => {
    await scenario({ ads: 10, nsStock: 4 });
    const { runShadowReconciliation } = await import("@/lib/inventory/shadow");
    await runShadowReconciliation(sql(), { requestedBy: ACTOR });
    const [a] = await sql().query<{ status: string; simulated: boolean }>(`SELECT status, simulated FROM inventory_channel_allocations WHERE channel = 'nuvemshop'`);
    expect(a).toEqual({ status: "SIMULATED", simulated: true });
    expect((await stockRun()).status).toBe("SKIPPED");
  });
});

// ---------------------------------------------------------------------------
describe("Automação: modos, kill switch, agendador e recuperação", () => {
  it("AUTOMATIC exige frase de confirmação e registra aprovação; escopo selecionado", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await expect(setAutomationMode(sql(), "STOCK", { mode: "AUTOMATIC" }, ACTOR)).rejects.toMatchObject({ code: "confirmation_required" });
    const a = await setAutomationMode(sql(), "STOCK", { mode: "AUTOMATIC", confirmation: AUTOMATIC_CONFIRMATION }, ACTOR);
    expect(a.automaticApprovedBy).toBe(ACTOR);
    let r = await stockRun();
    expect((await items(r.runId!))[0].decision).toBe("NOT_SELECTED");
    await setParticipation(sql(), { storeId: NS_STORE, kind: "STOCK", variantIds: ["100"], participation: "INCLUDED", actor: ACTOR });
    r = await stockRun();
    expect((await items(r.runId!))[0].decision).toBe("WRITE");
    await writer();
    expect(ns.stockOf(100)).toBe(4);
    await expect(setAutomationMode(sql(), "STOCK", { mode: "PILOT" }, ACTOR, async () => ["bloqueio de teste"])).rejects.toBeInstanceOf(AutomationError);
  });

  it("desligamento de emergência: cancela jobs enfileirados, impede criação e execução, pausa as automações; liberar mantém pausado", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    await stockRun();
    expect((await jobs())[0].status).toBe("PENDING");
    await activateEmergencyStop(sql(), ACTOR, "teste de emergência");
    expect((await jobs())[0].status).toBe("CANCELED");
    await writer();
    expect(nsWrites()).toHaveLength(0);
    expect(await enqueueWrite(sql(), { kind: "STOCK", storeId: NS_STORE, nsProductId: "1", variantId: "100", locationId: "LOC-A", expected: "0", target: "4", mode: "MANUAL", runId: null, createdBy: ACTOR })).toMatchObject({ created: false, reason: "EMERGENCY_STOP" });
    await expect(setAutomationMode(sql(), "STOCK", { mode: "PILOT" }, ACTOR)).rejects.toMatchObject({ code: "emergency_stop_active" });
    await expect(updateProduct(sql(), "1", { name: "x" }, ACTOR, deps())).rejects.toThrow(/emergência/);
    await releaseEmergencyStop(sql(), ACTOR);
    expect((await (await import("@/lib/nuvemshop/automation")).getAutomation(sql(), "STOCK")).mode).toBe("PAUSED");
    await resumeAutomation(sql(), "STOCK", ACTOR);
    await stockRun();
    await writer();
    expect(ns.stockOf(100)).toBe(4);
  });

  it("agendador: o ciclo roda sem painel (webhooks, pedidos, estoque e escrita); worker interrompido é recuperado por leitura", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    await protect();
    await pilot("STOCK");
    ns.orders.push(order(6001, { qty: 1 }));
    ns.sell(100, 0);
    await recordWebhookEvent(sql(), "{}", { store_id: NS_STORE, event: "order/created", id: 6001, event_launch_ts: 2 });
    // ADS fora do ar na leitura ao vivo: nada é escrito (saldo desconhecido não vira zero).
    let tick = await runNuvemshopTick(sql(), Date.now() + 200_000, deps());
    expect(tick.ran).toBe(true);
    expect(await reservations()).toHaveLength(1);
    expect(nsWrites()).toHaveLength(0);
    // ADS de volta: o próximo ciclo vencido escreve.
    adsStocks = [adsStockRow(77, 10)];
    await sql().execute(`UPDATE nuvemshop_automation_settings SET next_run_at = now() WHERE kind = 'STOCK'`);
    tick = await runNuvemshopTick(sql(), Date.now() + 200_000, deps());
    // ADS 10 − 1 pendente − 2 reserva = 7 → ML 4 (prioridade e sobra) + Nuvemshop 3.
    expect(ns.stockOf(100)).toBe(3);
    // Job RUNNING abandonado (worker morreu): vira UNCERTAIN e é resolvido pela leitura.
    await sql().execute(`UPDATE nuvemshop_write_jobs SET status = 'RUNNING', started_at = now() - interval '5 minutes' WHERE status = 'SUCCEEDED'`);
    await writer();
    expect((await jobs())[0].status).toBe("UNCERTAIN");
    await sql().execute(`UPDATE nuvemshop_write_jobs SET updated_at = now() - interval '1 minute'`);
    await resolveUncertainJobs(sql(), deps());
    expect((await jobs())[0].status).toBe("SUCCEEDED");
    const [hb] = await sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM app_settings WHERE key = 'nuvemshop_tick_last'`);
    expect(hb.n).toBe(1);
  });

  it("proteção de pedidos: exige read_orders, webhooks de pedido e reconciliação recente", async () => {
    await scenario({ ads: 10 });
    const store = { storeId: NS_STORE, grantedScopes: "read_products,write_products" };
    expect((await orderProtectionState(sql(), store)).reasons.join(" ")).toMatch(/read_orders/);
    await protect();
    expect((await orderProtectionState(sql(), { ...store, grantedScopes: "read_orders" })).ready).toBe(true);
    expect(ns.webhooks.map((w) => w.event).sort()).toEqual(["order/created", "order/updated", "product/created", "product/deleted", "product/updated"]);
    await registerWebhooks(sql(), ACTOR, deps());
    expect(ns.webhooks).toHaveLength(5); // não duplica
  });

  it("rotas do painel: administrador, mesma origem, simulação sem escrita e pausa de emergência", async () => {
    await scenario({ ads: 10, nsStock: 0 });
    expect((await automationGet(makeRequest("/api/nuvemshop/automation"))).status).toBe(401);
    const ov = await (await automationGet(makeRequest("/api/nuvemshop/automation", { cookies: adminCookies() }))).json();
    expect(ov.automations.map((a: { mode: string }) => a.mode)).toEqual(["DISABLED", "DISABLED"]);
    expect((await automationPost(makeRequest("/api/nuvemshop/automation", { method: "POST", cookies: adminCookies(), body: { action: "emergency_stop", reason: "x" } }))).status).toBe(403);
    const original = globalThis.fetch;
    globalThis.fetch = ns.fetch as unknown as typeof fetch;
    try {
      const sim = await automationPost(makeRequest("/api/nuvemshop/automation", { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "simulate", kind: "STOCK" } }));
      expect(sim.status).toBe(200);
      expect(nsWrites()).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
    const stop = await automationPost(makeRequest("/api/nuvemshop/automation", { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "emergency_stop", reason: "teste" } }));
    expect(stop.status).toBe(200);
    const bad = await automationPost(makeRequest("/api/nuvemshop/automation", { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "set_mode", kind: "STOCK", mode: "AUTOMATIC" } }));
    expect(bad.status).toBe(409);
  });
});
