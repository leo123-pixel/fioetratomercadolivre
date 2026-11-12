import { describe, expect, it } from "vitest";
import { POST as discoverPost } from "@/app/api/legacy-listings/discover/route";
import { GET as listGet } from "@/app/api/legacy-listings/route";
import { DELETE as mapDelete, POST as mapPost } from "@/app/api/legacy-listings/[id]/map/route";
import { POST as rejectPost } from "@/app/api/legacy-listings/[id]/reject/route";
import { POST as batchPost } from "@/app/api/legacy-listings/map-batch/route";
import { POST as applyPost } from "@/app/api/stock-sync/apply/route";
import { POST as previewPost } from "@/app/api/stock-sync/preview/route";
import { PATCH as settingsPatch } from "@/app/api/stock-sync/settings/route";
import { POST as validatePost } from "@/app/api/stock-sync/validate/route";
import { runTick } from "@/lib/marketplace/scheduler";
import { discoverLegacyListings } from "@/lib/stock/legacy";
import { confirmLink } from "@/lib/stock/links";
import { resetMultigetFallback } from "@/lib/meli/items";
import { isValidGtin } from "@/lib/stock/matching";
import { processStockJobs, runAutoStockSync, runPreview, validateProposals, applyProposals, type ProposalView } from "@/lib/stock/reconcile";
import { updateGroupPolicy, updateStockSettings } from "@/lib/stock/settings";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";
import { item, mockStock, type MockItem } from "./helpers/stock-mock";

const t = useTestDatabase();
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const ACTOR = "admin:teste";
const ORIGIN = { origin: BASE };

/** EAN-13 válido a partir de 12 dígitos. */
function ean(base12: string): string {
  const d = base12.split("").map(Number);
  const sum = d.reduce((a, n, i) => a + n * (i % 2 === 0 ? 1 : 3), 0);
  return base12 + String((10 - (sum % 10)) % 10);
}

async function product(ads: number, o: { ean?: string; mfr?: string; kit?: boolean; supplier?: number; inactive?: boolean } = {}): Promise<number> {
  const [{ id }] = await t
    .sql()
    .query<{ id: number }>(
      `INSERT INTO products (ads_product_id, name_original, ean, manufacturer_code, supplier_id, inactive, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [ads, `PRODUTO ${ads}`, o.ean ?? null, o.mfr ?? null, o.supplier ?? null, o.inactive ?? false, JSON.stringify({ kit: o.kit ?? false })],
    );
  return id;
}

async function setup(items: MockItem[], ads: { produtoId: number; estoque: number; filialId?: string }[] = [], extra: Parameters<typeof mockStock>[0] = {}) {
  await seedConnection({ expiresInMs: 3_600_000 });
  const m = mockStock({ ...extra, ads: ads.map((a) => ({ filialId: a.filialId ?? "01", ...a })) });
  for (const it of items) m.state.items.set(it.id, it);
  await updateStockSettings(t.sql(), { stockSourceConfirmed: true }, ACTOR);
  return m;
}

const discover = () => discoverLegacyListings(t.sql(), { refreshMinutes: 0 });
async function rowId(itemId: string, variationId = ""): Promise<string> {
  const [r] = await t.sql().query<{ id: string }>(`SELECT id::text AS id FROM legacy_listings WHERE marketplace_item_id = $1 AND variation_id = $2`, [itemId, variationId]);
  return r.id;
}
async function link(itemId: string, productId: number, o: { variationId?: string; components?: { productId: number; quantity: number }[]; maxQuantity?: number } = {}) {
  return confirmLink(t.sql(), await rowId(itemId, o.variationId ?? ""), { productId, components: o.components, maxQuantity: o.maxQuantity }, ACTOR);
}
const preview = (itemIds?: string[]) => runPreview(t.sql(), { requestedBy: ACTOR, itemIds });
const byItem = (ps: ProposalView[], id: string) => ps.find((p) => p.marketplaceItemIds.includes(id))!;

async function approve(ids: string[]) {
  const v = await validateProposals(t.sql(), ids);
  expect(v.blockers).toEqual([]);
  return applyProposals(t.sql(), { proposalIds: ids, confirmationToken: v.confirmationToken!, actor: ACTOR });
}

describe("descoberta de anúncios legados", () => {
  it("1. classifica anúncios da conta (integrador × externos) sem escrever no ML", async () => {
    const m = await setup([item("MLB1"), item("MLB2", { seller_custom_field: "XPTO" })]);
    const p = await product(100);
    const [{ id: draft }] = await t.sql().query<{ id: number }>(`INSERT INTO listing_drafts (product_id, status) VALUES ($1, 'PUBLISHED') RETURNING id`, [p]);
    await t.sql().execute(
      `INSERT INTO marketplace_listings (product_id, ads_product_id, listing_draft_id, marketplace_account_id, marketplace_item_id, category_id, price, quantity, status)
       VALUES ($1, 100, $2, '42', 'MLB1', 'MLB264861', 10, 10, 'active')`,
      [p, draft],
    );
    const res = await discoverPost(makeRequest("/api/legacy-listings/discover", { method: "POST", cookies: adminCookies(), headers: ORIGIN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ listed: 2, fetched: 2, complete: true });
    const rows = await t.sql().query<{ id: string; origin: string; seller_sku: string | null }>(`SELECT marketplace_item_id AS id, origin, seller_sku FROM legacy_listings ORDER BY 1`);
    expect(rows).toEqual([
      { id: "MLB1", origin: "INTEGRATOR", seller_sku: null },
      { id: "MLB2", origin: "EXTERNAL", seller_sku: "XPTO" },
    ]);
    expect(m.puts()).toHaveLength(0);
    // Exige administrador.
    expect((await discoverPost(makeRequest("/api/legacy-listings/discover", { method: "POST", headers: ORIGIN }))).status).toBe(401);
  });

  it("2. pagina a busca da conta e usa o multiget de 20 em 20", async () => {
    const items = Array.from({ length: 130 }, (_, i) => item(`MLB${1000 + i}`));
    const m = await setup(items);
    const r = await discover();
    expect(r.listed).toBe(130);
    expect(r.fetched).toBe(130);
    const searches = m.state.calls.filter((c) => c.path.startsWith("/users/42/items/search"));
    expect(searches.length).toBe(2);
    const multigets = m.state.calls.filter((c) => c.path.startsWith("/items?"));
    expect(multigets.length).toBe(7);
    // Item que sumiu da conta numa varredura completa é marcado como removido (não apagado).
    m.state.items.delete("MLB1000");
    await discover();
    const [{ removed }] = await t.sql().query<{ removed: boolean }>(`SELECT removed_at IS NOT NULL AS removed FROM legacy_listings WHERE marketplace_item_id = 'MLB1000'`);
    expect(removed).toBe(true);
  });

  it("3. identifica anúncios sem vínculo (filtros do painel)", async () => {
    await setup([item("MLB1"), item("MLB2"), item("MLB3", { status: "closed" })]);
    const p = await product(100);
    await discover();
    await link("MLB2", p);
    const res = await listGet(makeRequest("/api/legacy-listings?filter=unmapped", { cookies: adminCookies() }));
    const body = await res.json();
    expect(body.items.map((i: { marketplaceItemId: string }) => i.marketplaceItemId).sort()).toEqual(["MLB1", "MLB3"]);
    expect(body.counts).toMatchObject({ all: 3, unmapped: 2, linked: 1, unmanageable: 1 });
  });
});

describe("motor de correspondência", () => {
  it("4. SKU originado da ADS gera sugestão única de confiança alta; lote vincula com confirmação", async () => {
    await setup([item("MLB1", { attributes: [{ id: "SELLER_SKU", value_name: "ADS-100" }] })]);
    const p = await product(100);
    await discover();
    const [row] = await t.sql().query<{ id: string; pid: number; src: string; conf: string }>(
      `SELECT id::text AS id, suggested_product_id AS pid, suggestion_source AS src, suggestion_confidence AS conf FROM legacy_listings`,
    );
    expect(row).toMatchObject({ pid: p, src: "SKU_MATCH", conf: "HIGH" });
    // Sem confirmação explícita: recusado.
    expect((await batchPost(makeRequest("/api/legacy-listings/map-batch", { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { items: [{ id: row.id, productId: p }] } }))).status).toBe(400);
    const res = await batchPost(makeRequest("/api/legacy-listings/map-batch", { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { items: [{ id: row.id, productId: p }], confirm: true } }));
    const body = await res.json();
    expect(body.linked).toHaveLength(1);
    const [m] = await t.sql().query<{ source: string; product_id: number }>(`SELECT source, product_id FROM marketplace_product_mappings WHERE active`);
    expect(m).toEqual({ source: "SKU_MATCH", product_id: p });
  });

  it("5. GTIN válido sugere; GTIN com dígito verificador inválido é ignorado", async () => {
    const good = ean("789601410001");
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    expect(isValidGtin(good)).toBe(true);
    expect(isValidGtin(bad)).toBe(false);
    await setup([item("MLB1", { attributes: [{ id: "GTIN", value_name: good }] }), item("MLB2", { attributes: [{ id: "GTIN", value_name: bad }] })]);
    const p = await product(100, { ean: good });
    await product(101, { ean: bad });
    await discover();
    const rows = await t.sql().query<{ item: string; pid: number | null; src: string | null; n: number }>(
      `SELECT marketplace_item_id AS item, suggested_product_id AS pid, suggestion_source AS src, candidate_count AS n FROM legacy_listings ORDER BY 1`,
    );
    expect(rows).toEqual([
      { item: "MLB1", pid: p, src: "GTIN_MATCH", n: 1 },
      { item: "MLB2", pid: null, src: null, n: 0 },
    ]);
  });

  it("6. vários candidatos = correspondência ambígua (lote recusa; escolha manual permitida)", async () => {
    const code = ean("789601410002");
    await setup([item("MLB1", { attributes: [{ id: "GTIN", value_name: code }] })]);
    const a = await product(100, { ean: code });
    await product(101, { ean: code });
    await discover();
    const id = await rowId("MLB1");
    const [row] = await t.sql().query<{ n: number; pid: number | null }>(`SELECT candidate_count AS n, suggested_product_id AS pid FROM legacy_listings`);
    expect(row).toEqual({ n: 2, pid: null });
    const list = await (await listGet(makeRequest("/api/legacy-listings?filter=ambiguous", { cookies: adminCookies() }))).json();
    expect(list.items[0].linkStatus).toBe("AMBIGUOUS");
    const batch = await (await batchPost(makeRequest("/api/legacy-listings/map-batch", { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { items: [{ id, productId: a }], confirm: true } }))).json();
    expect(batch.linked).toHaveLength(0);
    expect(batch.skipped[0].reason).toMatch(/ambígua/);
    const res = await mapPost(makeRequest(`/api/legacy-listings/${id}/map`, { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { productId: a, confirm: true } }), ctx({ id }));
    expect(res.status).toBe(201);
    expect((await res.json()).source).toBe("GTIN_MATCH");
  });

  it("7. vínculo manual: confirmação, recusa de sugestão, remoção com confirmação e auditoria", async () => {
    await setup([item("MLB1", { attributes: [{ id: "SELLER_SKU", value_name: "ADS-100" }] })]);
    const suggested = await product(100);
    const chosen = await product(200);
    await discover();
    const id = await rowId("MLB1");
    await rejectPost(makeRequest(`/api/legacy-listings/${id}/reject`, { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { productId: suggested } }), ctx({ id }));
    const [after] = await t.sql().query<{ n: number }>(`SELECT candidate_count AS n FROM legacy_listings`);
    expect(after.n).toBe(0);
    expect((await mapPost(makeRequest(`/api/legacy-listings/${id}/map`, { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { productId: chosen } }), ctx({ id }))).status).toBe(400);
    const ok = await mapPost(makeRequest(`/api/legacy-listings/${id}/map`, { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: { productId: chosen, confirm: true } }), ctx({ id }));
    expect((await ok.json()).source).toBe("MANUAL");
    expect((await mapDelete(makeRequest(`/api/legacy-listings/${id}/map`, { method: "DELETE", cookies: adminCookies(), headers: ORIGIN, body: {} }), ctx({ id }))).status).toBe(400);
    expect((await mapDelete(makeRequest(`/api/legacy-listings/${id}/map`, { method: "DELETE", cookies: adminCookies(), headers: ORIGIN, body: { confirm: true } }), ctx({ id }))).status).toBe(200);
    const events = await t.sql().query<{ e: string }>(`SELECT event_type AS e FROM stock_sync_history WHERE marketplace_item_id = 'MLB1' ORDER BY id`);
    expect(events.map((x) => x.e)).toEqual(["suggestion_rejected", "link_confirmed", "link_removed"]);
    const [m] = await t.sql().query<{ active: boolean; by: string }>(`SELECT active, deactivated_by AS by FROM marketplace_product_mappings`);
    expect(m.active).toBe(false);
    expect(m.by).toMatch(/^admin:/);
  });

  it("8. vários anúncios do mesmo produto: sem regra de alocação bloqueia; SPLIT_EVEN divide sem multiplicar", async () => {
    await setup([item("MLB1", { available_quantity: 9 }), item("MLB2", { available_quantity: 9 })], [{ produtoId: 100, estoque: 9 }]);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    await link("MLB2", p);
    let r = await preview();
    expect(r.proposals.every((x) => x.reasonCode === "ALLOCATION_REQUIRED")).toBe(true);
    await updateGroupPolicy(t.sql(), p, { allocationMode: "SPLIT_EVEN" }, ACTOR);
    r = await preview();
    const qs = r.proposals.map((x) => x.proposedQuantity!);
    expect(qs).toEqual([4, 4]);
    expect(qs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9);
  });

  it("9. variações: vínculo por variação e PUT com todas as variações (só a alvo muda)", async () => {
    const m = await setup(
      [
        item("MLB1", {
          available_quantity: 30,
          variations: [
            { id: 11, available_quantity: 20, attribute_combinations: [{ name: "Cor", value_name: "Preto" }], attributes: [{ id: "SELLER_SKU", value_name: "ADS-100" }] },
            { id: 12, available_quantity: 10, attribute_combinations: [{ name: "Cor", value_name: "Loiro" }], attributes: [{ id: "SELLER_SKU", value_name: "ADS-101" }] },
          ],
        }),
      ],
      [
        { produtoId: 100, estoque: 5 },
        { produtoId: 101, estoque: 7 },
      ],
    );
    const p100 = await product(100);
    await product(101);
    await discover();
    const rows = await t.sql().query<{ v: string; label: string; pid: number }>(`SELECT variation_id AS v, variation_label AS label, suggested_product_id AS pid FROM legacy_listings ORDER BY 1`);
    expect(rows.map((r) => r.label)).toEqual(["Cor: Preto", "Cor: Loiro"]);
    await link("MLB1", p100, { variationId: "11" });
    const r = await preview();
    expect(r.proposals).toHaveLength(1);
    const prop = r.proposals[0];
    expect(prop).toMatchObject({ stockModel: "CLASSIC_VARIATION", marketplaceQuantity: 20, proposedQuantity: 5, direction: "DECREASE" });
    const out = await approve([prop.id]);
    expect(out.jobs[0].status).toBe("SUCCEEDED");
    expect(m.puts()[0].body).toEqual({ variations: [{ id: 11, available_quantity: 5 }, { id: 12 }] });
    expect(m.state.items.get("MLB1")!.variations!.map((v) => v.available_quantity)).toEqual([5, 10]);
  });

  it("10. kits: produto kit exige composição; quantidade = mínimo entre componentes ÷ quantidade por venda", async () => {
    await setup([item("MLB1", { available_quantity: 50 })], [
      { produtoId: 100, estoque: 9 },
      { produtoId: 101, estoque: 20 },
    ]);
    const kit = await product(900, { kit: true });
    const a = await product(100);
    const b = await product(101);
    await discover();
    await expect(link("MLB1", kit)).rejects.toThrow(/composição/);
    await link("MLB1", kit, { components: [{ productId: a, quantity: 2 }, { productId: b, quantity: 3 }] });
    const r = await preview();
    // A: ⌊9/2⌋ = 4; B: ⌊20/3⌋ = 6 → 4 kits.
    expect(r.proposals[0].proposedQuantity).toBe(4);
  });
});

describe("saldo da ADS", () => {
  it("11. saldo positivo: 8 na ADS, 25 no ML → propõe 8; com reserva de segurança 2 → 6", async () => {
    await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    let prop = (await preview()).proposals[0];
    expect(prop).toMatchObject({ adsQuantity: "8", marketplaceQuantity: 25, proposedQuantity: 8, difference: -17, direction: "DECREASE", eligible: true, stockModel: "CLASSIC" });
    await updateGroupPolicy(t.sql(), p, { safetyReserve: 2 }, ACTOR);
    prop = (await preview()).proposals[0];
    expect(prop.proposedQuantity).toBe(6);
    expect(prop.safetyReserve).toBe(2);
  });

  it("12. saldo zero propõe zero", async () => {
    await setup([item("MLB1", { available_quantity: 3 })], [{ produtoId: 100, estoque: 0 }]);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    expect((await preview()).proposals[0]).toMatchObject({ proposedQuantity: 0, direction: "DECREASE", eligible: true });
  });

  it("13. saldo não encontrado na ADS não vira zero", async () => {
    await setup([item("MLB1", { available_quantity: 3 })], []);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    expect((await preview()).proposals[0]).toMatchObject({ eligible: false, reasonCode: "ADS_STOCK_UNKNOWN", proposedQuantity: null });
  });

  it("14. falha na consulta à ADS bloqueia a proposta", async () => {
    const m = await setup([item("MLB1", { available_quantity: 3 })], [{ produtoId: 100, estoque: 1 }]);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    m.state.adsFail = true;
    expect((await preview()).proposals[0]).toMatchObject({ eligible: false, reasonCode: "ADS_ERROR" });
  });
});

describe("modelos de estoque", () => {
  it("15. estoque convencional: PUT /items com available_quantity (somente quantidade)", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    const prop = (await preview()).proposals[0];
    await approve([prop.id]);
    expect(m.puts()).toEqual([expect.objectContaining({ path: "/items/MLB1", body: { available_quantity: 8 } })]);
  });

  it("15b. multiget desligado pelo ML (403 Resource deprecated): lê anúncio por anúncio e o fluxo segue", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 }), item("MLB2", { available_quantity: 3 })], [{ produtoId: 100, estoque: 8 }]);
    m.state.multigetDeprecated = true;
    try {
      const p = await product(100);
      await discover();
      await link("MLB1", p);
      const prop = byItem((await preview()).proposals, "MLB1");
      expect(prop).toMatchObject({ marketplaceQuantity: 25, proposedQuantity: 8, eligible: true });
      const out = await approve([prop.id]);
      expect(out.jobs[0].status).toBe("SUCCEEDED");
      expect(m.state.calls.some((c) => c.method === "GET" && c.path.startsWith("/items/MLB1"))).toBe(true);
      // Depois do primeiro 403, não insiste no multiget.
      expect(m.state.calls.filter((c) => c.method === "GET" && c.path.startsWith("/items?")).length).toBe(1);
    } finally {
      resetMultigetFallback();
    }
  });

  it("16. User Products sem estoque distribuído: anúncios do mesmo UP são um único estoque (uma escrita)", async () => {
    const m = await setup(
      [item("MLB1", { user_product_id: "MLBU1", available_quantity: 12 }), item("MLB2", { user_product_id: "MLBU1", available_quantity: 12 })],
      [{ produtoId: 100, estoque: 5 }],
    );
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    await link("MLB2", p);
    const r = await preview();
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ poolKey: "up:MLBU1", stockModel: "UP_SHARED_ITEM", proposedQuantity: 5 });
    const out = await approve([r.proposals[0].id]);
    expect(out.jobs[0].status).toBe("SUCCEEDED");
    expect(m.puts()).toHaveLength(1);
    expect([...m.state.items.values()].map((i) => i.available_quantity)).toEqual([5, 5]);
  });

  it("17. multiorigem: selling_address via user-products/stock com x-version; seller_warehouse não é elegível", async () => {
    const m = await setup(
      [item("MLB1", { user_product_id: "MLAU1", available_quantity: 20 }), item("MLB2", { user_product_id: "MLBU2", available_quantity: 4 })],
      [
        { produtoId: 100, estoque: 7 },
        { produtoId: 101, estoque: 7 },
      ],
    );
    m.state.upStock.set("MLAU1", { locations: [{ type: "selling_address", quantity: 20 }], version: 3 });
    m.state.upStock.set("MLBU2", { locations: [{ type: "seller_warehouse", quantity: 4, store_id: "S1" }], version: 1 });
    await discover();
    await link("MLB1", await product(100));
    await link("MLB2", await product(101));
    const r = await preview();
    expect(byItem(r.proposals, "MLB1")).toMatchObject({ stockModel: "UP_SELLING_ADDRESS", marketplaceQuantity: 20, proposedQuantity: 7, eligible: true });
    expect(byItem(r.proposals, "MLB2")).toMatchObject({ stockModel: "MULTI_WAREHOUSE", eligible: false, reasonCode: "MULTI_WAREHOUSE" });
    await approve([byItem(r.proposals, "MLB1").id]);
    const put = m.puts()[0];
    expect(put.path).toBe("/user-products/MLAU1/stock/type/selling_address");
    expect(put.headers["x-version"]).toBe("3");
    expect(put.body).toEqual({ quantity: 7 });
    expect(m.state.upStock.get("MLAU1")!.locations[0].quantity).toBe(7);
  });

  it("17b. MLB: selling_address bloqueado na API de User Products → grava pelo anúncio e confere no User Product", async () => {
    const m = await setup(
      [item("MLB1", { user_product_id: "MLBU1", available_quantity: 2 })],
      [
        { produtoId: 100, estoque: 6 },
        { produtoId: 101, estoque: 6 },
      ],
    );
    m.state.upStock.set("MLBU1", { locations: [{ type: "selling_address", quantity: 2 }], version: 1 });
    await discover();
    await link("MLB1", await product(100));
    const r = await preview();
    expect(byItem(r.proposals, "MLB1")).toMatchObject({ stockModel: "UP_SELLING_ITEM", marketplaceQuantity: 2, proposedQuantity: 6, eligible: true });
    const out = await approve([byItem(r.proposals, "MLB1").id]);
    expect(out.jobs[0].status).toBe("SUCCEEDED");
    const put = m.puts()[0];
    expect(put.path).toBe("/items/MLB1");
    expect(put.body).toEqual({ available_quantity: 6 });
    expect(m.puts().some((p) => p.path.includes("/user-products/"))).toBe(false);
    expect(m.state.upStock.get("MLBU1")!.locations[0].quantity).toBe(6);
  });

  it("18. Full: não elegível (logística fulfillment ou só meli_facility)", async () => {
    const m = await setup(
      [item("MLB1", { shipping: { logistic_type: "fulfillment" } }), item("MLB2", { user_product_id: "MLBU2" })],
      [
        { produtoId: 100, estoque: 1 },
        { produtoId: 101, estoque: 1 },
      ],
    );
    m.state.upStock.set("MLBU2", { locations: [{ type: "meli_facility", quantity: 10 }], version: 1 });
    await discover();
    await link("MLB1", await product(100));
    await link("MLB2", await product(101));
    const r = await preview();
    expect(byItem(r.proposals, "MLB1")).toMatchObject({ stockModel: "FULFILLMENT", eligible: false });
    expect(byItem(r.proposals, "MLB2")).toMatchObject({ stockModel: "FULFILLMENT", eligible: false });
  });

  it("19. conflito de x-version: reconsulta e reavalia antes de escrever de novo", async () => {
    const m = await setup([item("MLB1", { user_product_id: "MLAU1", available_quantity: 20 })], [{ produtoId: 100, estoque: 7 }]);
    m.state.upStock.set("MLAU1", { locations: [{ type: "selling_address", quantity: 20 }], version: 3 });
    await discover();
    await link("MLB1", await product(100));
    const prop = (await preview()).proposals[0];
    m.state.putModes = ["409_external"];
    const out = await approve([prop.id]);
    expect(out.jobs[0].status).toBe("SUCCEEDED");
    const puts = m.puts();
    expect(puts.map((p) => p.headers["x-version"])).toEqual(["3", "4"]);
    const ops = await t.sql().query<{ op: string; http: number | null }>(`SELECT operation AS op, http_status AS http FROM stock_sync_attempts ORDER BY id`);
    expect(ops.map((o) => o.op)).toEqual(["EVALUATE", "PUT_UP_STOCK_SELLING_ADDRESS", "EVALUATE", "PUT_UP_STOCK_SELLING_ADDRESS", "VERIFY"]);
    expect(ops[1].http).toBe(409);
  });
});

describe("status do anúncio", () => {
  it("20. reduzir a zero pausa por falta de estoque e a mudança de status é registrada", async () => {
    const m = await setup([item("MLB1", { available_quantity: 3 })], [{ produtoId: 100, estoque: 0 }]);
    await discover();
    await link("MLB1", await product(100));
    const out = await approve([(await preview()).proposals[0].id]);
    expect(out.jobs[0]).toMatchObject({ status: "SUCCEEDED", appliedQuantity: 0, statusBefore: "MLB1:active", statusAfter: "MLB1:paused(out_of_stock)" });
    expect(m.state.items.get("MLB1")!.status).toBe("paused");
    const [ev] = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_sync_history WHERE event_type = 'listing_status_changed_by_quantity'`);
    expect(ev.n).toBe(1);
  });

  it("21. pausado manualmente: aumento bloqueado (não reativa), redução permitida; encerrado nunca é atualizado", async () => {
    await setup(
      [item("MLB1", { status: "paused", sub_status: [], available_quantity: 2 }), item("MLB2", { status: "paused", sub_status: [], available_quantity: 9 }), item("MLB3", { status: "closed", available_quantity: 1 })],
      [
        { produtoId: 100, estoque: 6 },
        { produtoId: 101, estoque: 4 },
        { produtoId: 102, estoque: 6 },
      ],
    );
    await discover();
    await link("MLB1", await product(100));
    await link("MLB2", await product(101));
    await link("MLB3", await product(102));
    const r = await preview();
    expect(byItem(r.proposals, "MLB1")).toMatchObject({ eligible: false, reasonCode: "PAUSED_MANUALLY", direction: "INCREASE" });
    expect(byItem(r.proposals, "MLB2")).toMatchObject({ eligible: true, direction: "DECREASE", proposedQuantity: 4 });
    expect(byItem(r.proposals, "MLB3")).toMatchObject({ eligible: false, reasonCode: "LISTING_NOT_ACTIVE" });
  });
});

describe("simulação, confirmação e aplicação", () => {
  it("22. simulação consulta dados reais e não envia PUT", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    await discover();
    await link("MLB1", await product(100));
    const res = await previewPost(makeRequest("/api/stock-sync/preview", { method: "POST", cookies: adminCookies(), headers: ORIGIN, body: {} }));
    const body = await res.json();
    expect(body.summary).toMatchObject({ eligible: 1, decrease: 1 });
    expect(body.proposals[0].status).toBe("PROPOSED");
    expect(m.puts()).toHaveLength(0);
    const [run] = await t.sql().query<{ mode: string; status: string }>(`SELECT mode, status FROM stock_sync_runs`);
    expect(run).toEqual({ mode: "DRY_RUN", status: "COMPLETED" });
  });

  it("23. confirmação manual: exige validação, token da mesma seleção, confirm=true e origem do saldo confirmada", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 }), item("MLB2", { available_quantity: 25 })], [
      { produtoId: 100, estoque: 8 },
      { produtoId: 101, estoque: 8 },
    ]);
    await discover();
    await link("MLB1", await product(100));
    await link("MLB2", await product(101));
    const r = await preview();
    const [a, b] = r.proposals.map((p) => p.id);
    const call = (body: unknown, route = applyPost, path = "/api/stock-sync/apply") => route(makeRequest(path, { method: "POST", cookies: adminCookies(), headers: ORIGIN, body }));
    expect((await call({ proposalIds: [a], confirmationToken: "x".repeat(30), confirm: true })).status).toBe(422);
    const v = await (await call({ proposalIds: [a] }, validatePost, "/api/stock-sync/validate")).json();
    expect(v.items[0]).toMatchObject({ ok: true, proposedQuantity: 8, freshProposedQuantity: 8 });
    expect((await call({ proposalIds: [a], confirmationToken: v.confirmationToken })).status).toBe(400); // falta confirm
    expect((await call({ proposalIds: [a, b], confirmationToken: v.confirmationToken, confirm: true })).status).toBe(422); // seleção diferente
    expect(m.puts()).toHaveLength(0);
    // Sem a confirmação da origem do saldo, a validação aponta bloqueio e não emite token.
    await updateStockSettings(t.sql(), { stockSourceConfirmed: false }, ACTOR);
    const blocked = await (await call({ proposalIds: [b] }, validatePost, "/api/stock-sync/validate")).json();
    expect(blocked.confirmationToken).toBeNull();
    expect(blocked.blockers.join(" ")).toMatch(/estoque vendável/);
    await updateStockSettings(t.sql(), { stockSourceConfirmed: true }, ACTOR);
    const ok = await (await call({ proposalIds: [a], confirmationToken: v.confirmationToken, confirm: true })).json();
    expect(ok.jobs[0]).toMatchObject({ status: "SUCCEEDED", authorizedBy: expect.stringMatching(/^admin:/), syncMode: "MANUAL" });
  });

  it("24. atualização bem-sucedida: confere no ML, atualiza o banco local e registra histórico", async () => {
    await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    await discover();
    await link("MLB1", await product(100));
    const prop = (await preview()).proposals[0];
    const out = await approve([prop.id]);
    expect(out.jobs[0]).toMatchObject({ status: "SUCCEEDED", beforeQuantity: 25, appliedQuantity: 8, targetQuantity: 8 });
    const [row] = await t.sql().query<{ q: number }>(`SELECT available_quantity AS q FROM legacy_listings`);
    expect(row.q).toBe(8);
    const [p] = await t.sql().query<{ status: string; by: string }>(`SELECT status, approved_by AS by FROM stock_sync_proposals WHERE id = $1`, [prop.id]);
    expect(p).toEqual({ status: "APPLIED", by: ACTOR });
    const evs = await t.sql().query<{ e: string }>(`SELECT event_type AS e FROM stock_sync_history WHERE job_id IS NOT NULL ORDER BY id`);
    expect(evs.map((x) => x.e)).toEqual(["sync_authorized", "sync_succeeded"]);
  });

  it("25. HTTP 200 sem efeito: resultado DIVERGED (não assume sucesso)", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    await discover();
    await link("MLB1", await product(100));
    m.state.putModes = ["ignore"];
    const out = await approve([(await preview()).proposals[0].id]);
    expect(out.jobs[0]).toMatchObject({ status: "DIVERGED", appliedQuantity: 25, errorCode: "NOT_REFLECTED" });
  });

  it("26. retentativas: erro 500 reagenda; timeout já aplicado é confirmado pela leitura", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 }), item("MLB2", { available_quantity: 25 })], [
      { produtoId: 100, estoque: 8 },
      { produtoId: 101, estoque: 6 },
    ]);
    await discover();
    await link("MLB1", await product(100));
    await link("MLB2", await product(101));
    const r = await preview();
    m.state.putModes = ["500"];
    let out = await approve([byItem(r.proposals, "MLB1").id]);
    expect(out.jobs[0]).toMatchObject({ status: "QUEUED", attempts: 1, errorCode: expect.stringMatching(/^server/) });
    await t.sql().execute(`UPDATE stock_sync_jobs SET next_run_at = now()`);
    await processStockJobs(t.sql());
    const [job] = await t.sql().query<{ status: string; attempts: number }>(`SELECT status, attempts FROM stock_sync_jobs WHERE pool_key = 'item:MLB1'`);
    expect(job).toEqual({ status: "SUCCEEDED", attempts: 2 });
    m.state.putModes = ["timeout_applied"];
    out = await approve([byItem(r.proposals, "MLB2").id]);
    expect(out.jobs[0]).toMatchObject({ status: "SUCCEEDED", appliedQuantity: 6 });
  });

  it("27. vendas concorrentes: pedido não refletido na ADS é descontado; venda recente bloqueia aumento", async () => {
    await setup([item("MLB1", { available_quantity: 1 }), item("MLB2", { available_quantity: 1 })], [
      { produtoId: 100, estoque: 8 },
      { produtoId: 101, estoque: 8 },
    ]);
    const p = await product(100);
    const p2 = await product(101);
    await discover();
    await link("MLB1", p);
    await link("MLB2", p2);
    const sql = t.sql();
    // Pedido pago há 1 hora do MLB1 (3 unidades), ainda não enviado à ADS.
    const [{ id: o1 }] = await sql.query<{ id: string }>(
      `INSERT INTO marketplace_order_inbox (marketplace_order_id, seller_id, order_status, date_created) VALUES ('2001', '42', 'paid', now() - interval '1 hour') RETURNING id::text AS id`,
    );
    await sql.execute(`INSERT INTO marketplace_order_items (order_id, line_key, marketplace_item_id, quantity, product_id, ads_product_id, mapping_status) VALUES ($1, 'l1', 'MLB1', 3, $2, 100, 'MAPPED')`, [o1, p]);
    // Pedido de MLB2 de 2 minutos atrás: a ADS pode não ter visto ainda.
    const [{ id: o2 }] = await sql.query<{ id: string }>(
      `INSERT INTO marketplace_order_inbox (marketplace_order_id, seller_id, order_status, date_created) VALUES ('2002', '42', 'paid', now() - interval '2 minutes') RETURNING id::text AS id`,
    );
    await sql.execute(`INSERT INTO marketplace_order_items (order_id, line_key, marketplace_item_id, quantity, product_id, ads_product_id, mapping_status) VALUES ($1, 'l1', 'MLB2', 1, $2, 101, 'MAPPED')`, [o2, p2]);
    const r = await preview();
    expect(byItem(r.proposals, "MLB1")).toMatchObject({ pendingOrders: "3", proposedQuantity: 5, direction: "INCREASE", eligible: true });
    expect(byItem(r.proposals, "MLB2")).toMatchObject({ eligible: false, reasonCode: "RECENT_SALE" });
    // Depois de enviado à ADS (SENT), o pedido deixa de ser descontado.
    await sql.execute(
      `INSERT INTO ads_order_submissions (order_id, marketplace_order_id, external_id, environment, status, payload, payload_hash, requested_by, sent_at)
       VALUES ($1, '2001', 'ML-2001', 'producao', 'SENT', '{}', 'h', 'x', now())`,
      [o1],
    );
    expect(byItem((await preview(["MLB1"])).proposals, "MLB1")).toMatchObject({ pendingOrders: "0", proposedQuantity: 8 });
  });

  it("28. impede estoque inflado: queda no ML sem pedido e proposta antiga com saldo diferente não aumentam", async () => {
    const m = await setup([item("MLB1", { available_quantity: 5 }), item("MLB2", { available_quantity: 2 })], [
      { produtoId: 100, estoque: 9 },
      { produtoId: 101, estoque: 9 },
    ]);
    await discover();
    await link("MLB1", await product(100));
    await link("MLB2", await product(101));
    // Venda no ML ainda não recebida pelo integrador: quantidade caiu de 5 para 4.
    m.state.items.get("MLB1")!.available_quantity = 4;
    const r = await preview();
    expect(byItem(r.proposals, "MLB1")).toMatchObject({ eligible: false, reasonCode: "UNPROCESSED_SALE" });
    const p2 = byItem(r.proposals, "MLB2");
    expect(p2).toMatchObject({ eligible: true, proposedQuantity: 9 });
    const v = await validateProposals(t.sql(), [p2.id]);
    // Saldo na ADS cai entre a confirmação e a execução: o job reavalia e não escreve o valor antigo.
    m.state.ads.find((a) => a.produtoId === 101)!.estoque = 3;
    const out = await applyProposals(t.sql(), { proposalIds: [p2.id], confirmationToken: v.confirmationToken!, actor: ACTOR });
    expect(out.jobs[0]).toMatchObject({ status: "STALE", errorCode: "PROPOSAL_CHANGED" });
    expect(m.puts()).toHaveLength(0);
  });

  it("29. idempotência: repetir a mesma confirmação não cria outro job nem outra escrita", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    await discover();
    await link("MLB1", await product(100));
    const prop = (await preview()).proposals[0];
    const v = await validateProposals(t.sql(), [prop.id]);
    const a = await applyProposals(t.sql(), { proposalIds: [prop.id], confirmationToken: v.confirmationToken!, actor: ACTOR });
    const b = await applyProposals(t.sql(), { proposalIds: [prop.id], confirmationToken: v.confirmationToken!, actor: ACTOR });
    expect(b.jobs[0].id).toBe(a.jobs[0].id);
    expect(m.puts()).toHaveLength(1);
    const [{ n }] = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_sync_jobs`);
    expect(n).toBe(1);
    // Um job ativo por estoque: índice único parcial.
    await t.sql().execute(`INSERT INTO stock_sync_jobs (pool_key, sync_mode, authorized_by, idempotency_key, target_quantity) VALUES ('item:X', 'MANUAL', 'a', 'k1', 1)`);
    await expect(t.sql().execute(`INSERT INTO stock_sync_jobs (pool_key, sync_mode, authorized_by, idempotency_key, target_quantity) VALUES ('item:X', 'MANUAL', 'a', 'k2', 1)`)).rejects.toThrow();
  });
});

describe("sincronização automática", () => {
  it("30. desativada por padrão; exige ambiente, homologação e ativação; só atua em grupos aprovados", async () => {
    const m = await setup([item("MLB1", { available_quantity: 25 })], [{ produtoId: 100, estoque: 8 }]);
    const p = await product(100);
    await discover();
    await link("MLB1", p);
    const sql = t.sql();
    expect(await runAutoStockSync(sql, { force: true })).toMatchObject({ ran: false, reason: expect.stringMatching(/STOCK_AUTO_SYNC_ENABLED/) });
    // O tick do agendador não escreve nada com a automação desligada.
    await runTick(sql, "manual");
    expect(m.puts()).toHaveLength(0);
    const patch = (body: unknown) => settingsPatch(makeRequest("/api/stock-sync/settings", { method: "PATCH", cookies: adminCookies(), headers: ORIGIN, body }));
    expect((await patch({ autoSyncEnabled: true })).status).toBe(409);
    process.env.STOCK_AUTO_SYNC_ENABLED = "true";
    try {
      expect((await (await patch({ autoSyncEnabled: true })).json()).error).toBe("homologation_required");
      expect((await (await patch({ homologate: true })).json()).error).toBe("homologation_required");
      await approve([(await preview()).proposals[0].id]); // atualização manual verificada = homologação possível
      expect((await patch({ homologate: true })).status).toBe(200);
      const on = await (await patch({ autoSyncEnabled: true })).json();
      expect(on.autoSync).toEqual({ active: true, reason: null });
      m.state.ads[0].estoque = 3;
      expect(await runAutoStockSync(sql, { force: true })).toMatchObject({ ran: false, reason: expect.stringMatching(/aprovado/) });
      await updateGroupPolicy(sql, p, { autoSyncApproved: true }, ACTOR);
      const auto = await runAutoStockSync(sql, { force: true });
      expect(auto).toMatchObject({ ran: true, jobs: 1 });
      expect(m.state.items.get("MLB1")!.available_quantity).toBe(3);
      const [job] = await sql.query<{ mode: string; by: string }>(`SELECT sync_mode AS mode, authorized_by AS by FROM stock_sync_jobs ORDER BY created_at DESC LIMIT 1`);
      expect(job).toEqual({ mode: "AUTO", by: "system:auto" });
      // Desativar interrompe a automação imediatamente.
      await patch({ autoSyncEnabled: false });
      m.state.ads[0].estoque = 1;
      expect(await runAutoStockSync(sql, { force: true })).toMatchObject({ ran: false });
      expect(m.state.items.get("MLB1")!.available_quantity).toBe(3);
    } finally {
      delete process.env.STOCK_AUTO_SYNC_ENABLED;
    }
  });
});

describe("correspondência por código do fabricante", () => {
  it("sugere com marca compatível (confiança média) e descarta marca incompatível", async () => {
    await setup([
      item("MLB1", { attributes: [{ id: "MPN", value_name: "h-0001234" }, { id: "BRAND", value_name: "L'Oréal Professionnel" }] }),
      item("MLB2", { attributes: [{ id: "MPN", value_name: "H0001234" }, { id: "BRAND", value_name: "Wella" }] }),
      item("MLB3", { attributes: [{ id: "MPN", value_name: "H0001234" }] }),
    ]);
    await t.sql().execute(`INSERT INTO ads_suppliers (id, name, trade_name) VALUES (547, 'LOREAL BRASIL', 'LOREAL')`);
    const p = await product(100, { mfr: "H0001234", supplier: 547 });
    await discover();
    const rows = await t.sql().query<{ item: string; pid: number | null; src: string | null; conf: string | null }>(
      `SELECT marketplace_item_id AS item, suggested_product_id AS pid, suggestion_source AS src, suggestion_confidence AS conf FROM legacy_listings ORDER BY 1`,
    );
    expect(rows).toEqual([
      { item: "MLB1", pid: p, src: "MANUFACTURER_MATCH", conf: "MEDIUM" },
      { item: "MLB2", pid: null, src: null, conf: null },
      { item: "MLB3", pid: p, src: "MANUFACTURER_MATCH", conf: "LOW" },
    ]);
  });
});
