import { describe, expect, it, vi } from "vitest";
import { resetAdsThrottleForTests } from "@/lib/ads/client";
import { setAdsClockForTesting } from "@/lib/ads/hours";
import type { PriceRow } from "@/lib/ads/schemas";
import { discoverLegacyListings } from "@/lib/stock/legacy";
import { confirmLink } from "@/lib/stock/links";
import {
  applyPriceProposals,
  getPriceProposals,
  latestPriceRun,
  runPricePreview,
  runAutoPriceSync,
  updatePriceSettings,
  buildPriceBody,
  DEFAULT_PRICE_SETTINGS,
  evaluatePrice,
  hasActivePromotion,
  pickPrice,
  type AdsPrice,
  type LinkedRow,
  type MlPriceState,
} from "@/lib/stock/prices";
import { ADS_BASE, price as adsPrice } from "./helpers/ads-mock";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";
import { item, mockStock } from "./helpers/stock-mock";

const t = useTestDatabase();
const ACTOR = "admin:teste";
const S = DEFAULT_PRICE_SETTINGS;
const row = (o: Partial<LinkedRow> = {}): LinkedRow => ({ itemId: "MLB1", variationId: "", title: "Shampoo", productId: 10, adsProductId: 9232, components: 0, ...o });
const ml = (o: Partial<MlPriceState> = {}): MlPriceState => ({
  found: true,
  status: "active",
  subStatus: [],
  price: 50,
  variationIds: [],
  variationPrices: [],
  logisticType: "xd_drop_off",
  ...o,
});
const known = (price: string): AdsPrice => ({ status: "KNOWN", price, branchId: "01", updatedAt: null });
const ads = (entries: [number, AdsPrice][]) => new Map(entries);

describe("evaluatePrice", () => {
  it("propõe o preço da ADS quando difere do ML", () => {
    const e = evaluatePrice([row()], ads([[10, known("55.90")]]), ml({ price: 50 }), S);
    expect(e.status).toBe("PROPOSED");
    expect(e.proposedPrice).toBe("55.90");
    expect(e.difference).toBe("5.90");
    expect(e.largeChange).toBe(false);
    expect(e.needsPromotionCheck).toBe(true);
  });

  it("marca em dia quando o preço é igual (ao centavo)", () => {
    const e = evaluatePrice([row()], ads([[10, known("49.99")]]), ml({ price: 49.99 }), S);
    expect(e.status).toBe("IN_SYNC");
    expect(e.needsPromotionCheck).toBe(false);
  });

  it("sinaliza variação grande acima do limite", () => {
    const e = evaluatePrice([row()], ads([[10, known("100.00")]]), ml({ price: 50 }), S);
    expect(e.status).toBe("PROPOSED");
    expect(e.largeChange).toBe(true);
  });

  it("nunca propõe preço ausente ou zero", () => {
    expect(evaluatePrice([row()], ads([[10, { status: "UNKNOWN", price: null, branchId: null, updatedAt: null }]]), ml(), S).reasonCode).toBe("NO_ADS_PRICE");
    expect(evaluatePrice([row()], ads([[10, known("0.00")]]), ml(), S).reasonCode).toBe("NO_ADS_PRICE");
    expect(evaluatePrice([row()], ads([[10, { status: "ERROR", price: null, branchId: null, updatedAt: null, error: "timeout" }]]), ml(), S).reasonCode).toBe("ADS_ERROR");
  });

  it("bloqueia kits, vínculo parcial, anúncio encerrado e variações com preços diferentes", () => {
    expect(evaluatePrice([row({ components: 2 })], ads([[10, known("10")]]), ml(), S).reasonCode).toBe("KIT");
    expect(evaluatePrice([row({ variationId: "1" }), row({ variationId: "2", productId: null, adsProductId: null })], ads([[10, known("10")]]), ml(), S).reasonCode).toBe(
      "PARTIAL_LINK",
    );
    expect(evaluatePrice([row()], ads([[10, known("10")]]), ml({ status: "closed" }), S).reasonCode).toBe("LISTING_NOT_ACTIVE");
    expect(evaluatePrice([row()], ads([[10, known("10")]]), ml({ found: false, status: "not_found" }), S).reasonCode).toBe("NOT_FOUND");
    const twoProducts = [row({ variationId: "1" }), row({ variationId: "2", productId: 11, adsProductId: 9233 })];
    expect(evaluatePrice(twoProducts, ads([[10, known("10")], [11, known("12")]]), ml({ variationIds: ["1", "2"], variationPrices: [50, 50] }), S).reasonCode).toBe(
      "VARIATION_PRICES_DIFFER",
    );
  });

  it("aceita variações de produtos com o mesmo preço", () => {
    const twoProducts = [row({ variationId: "1" }), row({ variationId: "2", productId: 11, adsProductId: 9233 })];
    const e = evaluatePrice(twoProducts, ads([[10, known("12")], [11, known("12.00")]]), ml({ variationIds: ["1", "2"], variationPrices: [50, 50] }), S);
    expect(e.status).toBe("PROPOSED");
    expect(e.variationIds).toEqual(["1", "2"]);
  });
});

describe("hasActivePromotion", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  it("detecta preço promocional vigente", () => {
    expect(hasActivePromotion({ prices: [{ type: "standard", amount: 50, regular_amount: null }, { type: "promotion", amount: 40, regular_amount: 50, conditions: {} }] }, now)).toBe(true);
  });
  it("ignora promoção futura ou encerrada e preço padrão", () => {
    expect(hasActivePromotion({ prices: [{ type: "standard", amount: 50, regular_amount: null }] }, now)).toBe(false);
    expect(hasActivePromotion({ prices: [{ type: "promotion", regular_amount: 50, conditions: { start_time: "2026-12-01T00:00:00Z" } }] }, now)).toBe(false);
    expect(hasActivePromotion({ prices: [{ type: "promotion", regular_amount: 50, conditions: { end_time: "2026-11-01T00:00:00Z" } }] }, now)).toBe(false);
  });
});

describe("buildPriceBody", () => {
  it("escreve só o preço; com variações envia todas com o mesmo valor", () => {
    expect(buildPriceBody([], "55.90")).toEqual({ price: 55.9 });
    expect(buildPriceBody(["111", "222"], "55.90")).toEqual({ variations: [{ id: 111, price: 55.9 }, { id: 222, price: 55.9 }] });
    expect(() => buildPriceBody([], "0")).toThrow();
  });
});

describe("pickPrice", () => {
  const p = (o: Partial<PriceRow>): PriceRow =>
    ({ ads_product_id: 9232, branch_id: "01", price_table_code: "M", price: "10.00", inactive: false, ads_updated_at: null, ...o }) as PriceRow;
  it("usa somente a tabela configurada, ativa, menor filial", () => {
    const rows = [p({ price_table_code: "F", price: "8.00" }), p({ branch_id: "02", price: "11.00" }), p({ branch_id: "01", price: "10.50" }), p({ branch_id: "00", inactive: true, price: "1.00" })];
    expect(pickPrice(rows, 9232, S)).toMatchObject({ status: "KNOWN", price: "10.50", branchId: "01" });
    expect(pickPrice(rows, 9232, { ...S, branchId: "02" })).toMatchObject({ price: "11.00" });
    expect(pickPrice(rows, 1, S).status).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Fluxo completo com banco (PGlite), ADS e Mercado Livre simulados.
// ---------------------------------------------------------------------------

interface PriceMockItem {
  price: number;
  variations?: { id: number; price: number }[];
}

async function scenario(opts: { mlPrices: Record<string, number>; ads: ReturnType<typeof adsPrice>[]; promo?: string[]; variations?: Record<string, number[]> }) {
  await seedConnection({ expiresInMs: 3_600_000 });
  const m = mockStock();
  for (const [id, p] of Object.entries(opts.mlPrices)) {
    const vars = opts.variations?.[id];
    m.state.items.set(id, { ...item(id), price: p, ...(vars ? { variations: vars.map((v) => ({ id: v, available_quantity: 5, price: p })) } : {}) } as never);
  }
  const state = { ads: opts.ads, promo: new Set(opts.promo ?? []), puts: [] as { path: string; body: Record<string, unknown> }[], adsDown: false };
  const inner = m.handler;
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === ADS_BASE && url.pathname.endsWith("/tabela-precos-itens")) {
        if (state.adsDown) return json({ title: "Service Unavailable" }, 503);
        const ids = url.searchParams.getAll("ids").map(Number);
        const rows = state.ads.filter((r) => ids.includes(r.produtoId));
        return json({ items: rows, page: 1, pageSize: 100, total: rows.length, hasNext: false });
      }
      const prices = url.pathname.match(/^\/items\/(MLB\d+)\/prices$/);
      if (url.origin === "https://api.mercadolibre.com" && prices) {
        const it = m.state.items.get(prices[1]) as unknown as PriceMockItem;
        const list: unknown[] = [{ type: "standard", amount: it.price, regular_amount: null }];
        if (state.promo.has(prices[1])) list.push({ type: "promotion", amount: it.price * 0.9, regular_amount: it.price });
        return json({ id: prices[1], prices: list });
      }
      const put = url.pathname.match(/^\/items\/(MLB\d+)$/);
      if (url.origin === "https://api.mercadolibre.com" && method === "PUT" && put) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        state.puts.push({ path: url.pathname, body });
        const it = m.state.items.get(put[1]) as unknown as PriceMockItem;
        if (Array.isArray(body.variations)) {
          const sent = body.variations as { id: number; price: number }[];
          if ((it.variations ?? []).some((v) => !sent.find((x) => x.id === v.id))) return json({ message: "variação omitida" }, 400);
          for (const v of sent) it.variations!.find((x) => x.id === v.id)!.price = v.price;
          it.price = sent[0].price;
        } else {
          if (Object.keys(body).some((k) => k !== "price")) return json({ message: "campo não permitido" }, 400);
          it.price = Number(body.price);
        }
        return json({ id: put[1], price: it.price });
      }
      return inner(input, init);
    }),
  );
  await discoverLegacyListings(t.sql(), { refreshMinutes: 0 });
  return state;
}

async function product(ads: number): Promise<number> {
  const [{ id }] = await t.sql().query<{ id: number }>(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, $3::jsonb) RETURNING id`, [ads, `P ${ads}`, "{}"]);
  return id;
}
async function link(itemId: string, productId: number, variationId = "") {
  const [r] = await t.sql().query<{ id: string }>(`SELECT id::text AS id FROM legacy_listings WHERE marketplace_item_id = $1 AND variation_id = $2`, [itemId, variationId]);
  return confirmLink(t.sql(), r.id, { productId }, ACTOR);
}

describe("sincronização de preço (fluxo completo)", () => {
  it("simula sem escrever, aplica só o selecionado, confere e ignora promoção/sem preço", async () => {
    const p1 = await product(9001);
    const p2 = await product(9002);
    const p3 = await product(9003);
    const p4 = await product(9004);
    const s = await scenario({
      mlPrices: { MLB1: 50, MLB2: 30, MLB3: 20, MLB4: 10 },
      ads: [adsPrice(9001, "M", 55.9), adsPrice(9001, "F", 99), adsPrice(9002, "M", 30), adsPrice(9003, "M", 25), adsPrice(9004, "F", 12)],
      promo: ["MLB3"],
    });
    await link("MLB1", p1);
    await link("MLB2", p2);
    await link("MLB3", p3);
    await link("MLB4", p4);

    const run = await runPricePreview(t.sql(), { requestedBy: ACTOR });
    expect(run.summary).toMatchObject({ items: 4, proposed: 1, inSync: 1, ineligible: 2 });
    expect(s.puts).toEqual([]);
    const ps = await getPriceProposals(t.sql(), run.runId);
    const by = (id: string) => ps.find((p) => p.marketplaceItemId === id)!;
    expect(by("MLB1")).toMatchObject({ status: "PROPOSED", marketplacePrice: "50.00", proposedPrice: "55.90" });
    expect(by("MLB2").status).toBe("IN_SYNC");
    expect(by("MLB3").reasonCode).toBe("PROMOTION_ACTIVE");
    expect(by("MLB4").reasonCode).toBe("NO_ADS_PRICE");

    const r = await applyPriceProposals(t.sql(), { proposalIds: ps.map((p) => p.id), actor: ACTOR, allowLargeChanges: false });
    expect(r.results.find((x) => x.itemId === "MLB1")!.status).toBe("APPLIED");
    expect(r.results.filter((x) => x.itemId !== "MLB1").every((x) => x.status === "SKIPPED")).toBe(true);
    expect(s.puts).toEqual([{ path: "/items/MLB1", body: { price: 55.9 } }]);
    const after = (await getPriceProposals(t.sql(), run.runId)).find((p) => p.marketplaceItemId === "MLB1")!;
    expect(after).toMatchObject({ status: "APPLIED", appliedPrice: "55.90", appliedBy: ACTOR });

    // Reaplicar a mesma proposta não escreve de novo.
    const again = await applyPriceProposals(t.sql(), { proposalIds: [after.id], actor: ACTOR, allowLargeChanges: false });
    expect(again.results[0].status).toBe("SKIPPED");
    expect(s.puts).toHaveLength(1);
  });

  it("não escreve se o preço mudou na ADS depois da simulação; variação grande exige confirmação", async () => {
    const p1 = await product(9101);
    const p2 = await product(9102);
    const s = await scenario({ mlPrices: { MLB11: 50, MLB12: 50 }, ads: [adsPrice(9101, "M", 52), adsPrice(9102, "M", 100)] });
    await link("MLB11", p1);
    await link("MLB12", p2);
    const run = await runPricePreview(t.sql(), { requestedBy: ACTOR });
    const ps = await getPriceProposals(t.sql(), run.runId);
    const big = ps.find((p) => p.marketplaceItemId === "MLB12")!;
    expect(big.largeChange).toBe(true);

    s.ads[0] = adsPrice(9101, "M", 53);
    const r = await applyPriceProposals(t.sql(), { proposalIds: ps.map((p) => p.id), actor: ACTOR, allowLargeChanges: false });
    expect(r.results.find((x) => x.itemId === "MLB11")!.status).toBe("STALE");
    expect(r.results.find((x) => x.itemId === "MLB12")!.status).toBe("SKIPPED");
    expect(s.puts).toEqual([]);

    const r2 = await applyPriceProposals(t.sql(), { proposalIds: [big.id], actor: ACTOR, allowLargeChanges: true });
    expect(r2.results[0].status).toBe("APPLIED");
    expect(s.puts).toEqual([{ path: "/items/MLB12", body: { price: 100 } }]);
  });

  it("aprovação por anúncio: simulação restrita não substitui a geral e invalida a proposta antiga do mesmo anúncio", async () => {
    const p1 = await product(9301);
    const p2 = await product(9302);
    const s = await scenario({ mlPrices: { MLB31: 10, MLB32: 20 }, ads: [adsPrice(9301, "M", 11), adsPrice(9302, "M", 21)] });
    await link("MLB31", p1);
    await link("MLB32", p2);
    const full = await runPricePreview(t.sql(), { requestedBy: ACTOR });
    expect(full.proposals).toEqual([]);
    const one = await runPricePreview(t.sql(), { requestedBy: ACTOR, itemIds: ["MLB31"] });
    expect(one.proposals).toHaveLength(1);
    expect(one.proposals[0]).toMatchObject({ marketplaceItemId: "MLB31", status: "PROPOSED", proposedPrice: "11.00" });
    expect((await latestPriceRun(t.sql()))!.id).toBe(full.runId);

    const fullProps = await getPriceProposals(t.sql(), full.runId);
    expect(fullProps.find((p) => p.marketplaceItemId === "MLB31")!.status).toBe("STALE");
    const other = fullProps.find((p) => p.marketplaceItemId === "MLB32")!;
    expect(other.status).toBe("PROPOSED");

    const r = await applyPriceProposals(t.sql(), { proposalIds: [one.proposals[0].id, other.id], actor: ACTOR, allowLargeChanges: false });
    expect(r.results.map((x) => x.status)).toEqual(["APPLIED", "APPLIED"]);
    expect(s.puts).toHaveLength(2);
  });

  it("anúncio com variações recebe o mesmo preço em todas as variações", async () => {
    const p1 = await product(9201);
    const s = await scenario({ mlPrices: { MLB21: 40 }, ads: [adsPrice(9201, "M", 42)], variations: { MLB21: [111, 222] } });
    await link("MLB21", p1, "111");
    await link("MLB21", p1, "222");
    const run = await runPricePreview(t.sql(), { requestedBy: ACTOR });
    const ps = await getPriceProposals(t.sql(), run.runId);
    expect(ps).toHaveLength(1);
    const r = await applyPriceProposals(t.sql(), { proposalIds: [ps[0].id], actor: ACTOR, allowLargeChanges: false });
    expect(r.results[0].status).toBe("APPLIED");
    expect(s.puts[0].body).toEqual({ variations: [{ id: 111, price: 42 }, { id: 222, price: 42 }] });
  });
});

describe("preço automático", () => {
  it("desligado por padrão; ligado, aplica diferenças (inclusive grandes, se configurado), respeita promoção e o intervalo", async () => {
    const p1 = await product(9301);
    const p2 = await product(9302);
    const p3 = await product(9303);
    const s = await scenario({
      mlPrices: { MLB31: 50, MLB32: 50, MLB33: 20 },
      ads: [adsPrice(9301, "M", 52), adsPrice(9302, "M", 100), adsPrice(9303, "M", 25)],
      promo: ["MLB33"],
    });
    await link("MLB31", p1);
    await link("MLB32", p2);
    await link("MLB33", p3);
    const sql = t.sql();
    expect(await runAutoPriceSync(sql)).toMatchObject({ ran: false, reason: expect.stringMatching(/STOCK_AUTO_SYNC_ENABLED/) });
    process.env.STOCK_AUTO_SYNC_ENABLED = "true";
    try {
      expect(await runAutoPriceSync(sql)).toMatchObject({ ran: false, reason: expect.stringMatching(/desativada/) });
      await updatePriceSettings(sql, { autoSyncEnabled: true, autoApplyLargeChanges: false }, ACTOR);
      const first = await runAutoPriceSync(sql);
      expect(first).toMatchObject({ ran: true, evaluated: 3, proposed: 1, applied: 1 });
      expect(s.puts).toEqual([{ path: "/items/MLB31", body: { price: 52 } }]); // +100% fica para aprovação; promoção nunca
      // Dentro do intervalo nada é reconsultado.
      expect(await runAutoPriceSync(sql)).toMatchObject({ ran: false, reason: expect.stringMatching(/já conferidos/) });
      await updatePriceSettings(sql, { autoApplyLargeChanges: true }, ACTOR);
      const second = await runAutoPriceSync(sql, { force: true });
      expect(second).toMatchObject({ ran: true, applied: 1 });
      expect(s.puts[1]).toEqual({ path: "/items/MLB32", body: { price: 100 } });
      const [row] = await sql.query<{ by: string }>(`SELECT applied_by AS by FROM price_sync_proposals WHERE marketplace_item_id = 'MLB32' AND status = 'APPLIED'`);
      expect(row.by).toBe("system:auto");
      expect(s.puts.some((p) => p.path === "/items/MLB33")).toBe(false);
      await updatePriceSettings(sql, { autoSyncEnabled: false }, ACTOR);
      expect(await runAutoPriceSync(sql, { force: true })).toMatchObject({ ran: false });
    } finally {
      delete process.env.STOCK_AUTO_SYNC_ENABLED;
    }
  });

  it("ADS fora do ar: nada é aplicado, a automação pausa e os preços voltam a ser conferidos quando a ADS responde", async () => {
    const p1 = await product(9311);
    const s = await scenario({ mlPrices: { MLB41: 50 }, ads: [adsPrice(9311, "M", 55)] });
    await link("MLB41", p1);
    const sql = t.sql();
    process.env.STOCK_AUTO_SYNC_ENABLED = "true";
    try {
      await updatePriceSettings(sql, { autoSyncEnabled: true }, ACTOR);
      s.adsDown = true;
      expect(await runAutoPriceSync(sql, { deadline: Date.now() + 30_000 })).toMatchObject({ ran: true, evaluated: 1, proposed: 0, applied: 0 });
      expect(s.puts).toHaveLength(0);
      expect(await runAutoPriceSync(sql)).toMatchObject({ ran: false, reason: expect.stringMatching(/ADS indisponível/) });
      s.adsDown = false;
      resetAdsThrottleForTests();
      // O anúncio com erro de ADS não conta como conferido: entra já no próximo ciclo.
      expect(await runAutoPriceSync(sql)).toMatchObject({ ran: true, applied: 1 });
      expect(s.puts).toEqual([{ path: "/items/MLB41", body: { price: 55 } }]);
    } finally {
      delete process.env.STOCK_AUTO_SYNC_ENABLED;
    }
  });

  it("fora do horário da ADS o preço automático fica em pausa", async () => {
    const p1 = await product(9321);
    const s = await scenario({ mlPrices: { MLB51: 50 }, ads: [adsPrice(9321, "M", 55)] });
    await link("MLB51", p1);
    const sql = t.sql();
    process.env.STOCK_AUTO_SYNC_ENABLED = "true";
    try {
      await updatePriceSettings(sql, { autoSyncEnabled: true }, ACTOR);
      setAdsClockForTesting(() => new Date("2026-11-13T02:00:00Z")); // 22:00 em Campo Grande
      expect(await runAutoPriceSync(sql)).toMatchObject({ ran: false, reason: expect.stringMatching(/Fora do horário da ADS/) });
      expect(s.puts).toHaveLength(0);
      setAdsClockForTesting(() => new Date("2026-11-12T12:00:00Z")); // 08:00
      expect(await runAutoPriceSync(sql)).toMatchObject({ ran: true, applied: 1 });
    } finally {
      delete process.env.STOCK_AUTO_SYNC_ENABLED;
    }
  });
});
