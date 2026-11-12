import "server-only";
import { AdsApiError, getAdsClient } from "../ads/client";
import { multigetItems } from "../meli/items";
import { mapPrices, type PriceRow } from "../ads/schemas";
import { upsertPrices } from "../imports/upserts";
import { logger, sanitize } from "../logger";
import { retrySleep, withReadRetry } from "../marketplace/errors";
import { MeliHttpError, meliRequest } from "../meli/api";
import type { Sql } from "../sql";
import { recordHistory } from "./settings";

/**
 * Sincronização de PREÇO ADS → Mercado Livre para anúncios legados (criados fora do integrador) já vinculados
 * a um produto da ADS. Fluxo sempre manual:
 *
 *   1. Simulação (somente leitura): consulta ao vivo o preço da tabela configurada (padrão "M") na ADS e o preço
 *      atual no ML; grava uma proposta por anúncio.
 *   2. Aplicação das propostas escolhidas pelo operador: reconsulta ADS, ML e promoções imediatamente antes de
 *      escrever; escreve só o preço (PUT /items/{id}) e confere o valor no ML depois.
 *
 * Nunca escreve preço ausente/zero, nunca altera anúncio em promoção, kit/pacote, Full encerrado etc.
 * Anúncios publicados pelo integrador ficam de fora: o preço deles é o escolhido no rascunho.
 */

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export interface PriceSyncSettings {
  /** Código da tabela de preço da ADS usada no Mercado Livre. */
  priceTableCode: string;
  /** Filial do preço (null = menor filial com preço ativo na tabela). */
  branchId: string | null;
  /** Variação (%) a partir da qual a aplicação exige confirmação adicional. */
  maxChangePct: number;
}

export const DEFAULT_PRICE_SETTINGS: PriceSyncSettings = { priceTableCode: "M", branchId: null, maxChangePct: 30 };
const SETTINGS_KEY = "price_sync_settings";

export async function getPriceSettings(sql: Sql): Promise<PriceSyncSettings> {
  const [row] = await sql.query<{ value: Partial<PriceSyncSettings> }>(`SELECT value FROM app_settings WHERE key = $1::text`, [SETTINGS_KEY]);
  const v = row?.value ?? {};
  return {
    priceTableCode: typeof v.priceTableCode === "string" && v.priceTableCode.trim() ? v.priceTableCode.trim() : DEFAULT_PRICE_SETTINGS.priceTableCode,
    branchId: typeof v.branchId === "string" && v.branchId.trim() ? v.branchId.trim() : null,
    maxChangePct: typeof v.maxChangePct === "number" && v.maxChangePct > 0 ? v.maxChangePct : DEFAULT_PRICE_SETTINGS.maxChangePct,
  };
}

// ---------------------------------------------------------------------------
// Cálculo (puro)
// ---------------------------------------------------------------------------

export const toCents = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const fromCents = (c: number) => (c / 100).toFixed(2);

export interface LinkedRow {
  itemId: string;
  variationId: string;
  title: string | null;
  productId: number | null;
  adsProductId: number | null;
  components: number;
}

export interface AdsPrice {
  status: "KNOWN" | "UNKNOWN" | "ERROR";
  price: string | null;
  branchId: string | null;
  updatedAt: string | null;
  error?: string;
}

export interface MlPriceState {
  found: boolean;
  status: string | null;
  subStatus: string[];
  price: number | null;
  variationIds: string[];
  variationPrices: (number | null)[];
  logisticType: string | null;
}

export interface PriceEvaluation {
  itemId: string;
  title: string | null;
  variationIds: string[];
  productIds: number[];
  adsProductIds: number[];
  adsPrice: string | null;
  adsUpdatedAt: string | null;
  branchId: string | null;
  marketplaceStatus: string | null;
  marketplacePrice: string | null;
  proposedPrice: string | null;
  difference: string | null;
  changePct: string | null;
  largeChange: boolean;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  status: "PROPOSED" | "IN_SYNC" | "INELIGIBLE";
  /** Precisa verificar promoção no ML antes de virar proposta. */
  needsPromotionCheck: boolean;
}

const WRITABLE_STATUS = new Set(["active", "paused"]);

/**
 * Decide a proposta de um anúncio a partir das linhas vinculadas (anúncio ou variações), do preço ADS de cada
 * produto e do estado atual no ML. Não consulta nada.
 */
export function evaluatePrice(rows: LinkedRow[], ads: Map<number, AdsPrice>, ml: MlPriceState, settings: PriceSyncSettings): PriceEvaluation {
  const linked = rows.filter((r) => r.productId !== null && r.adsProductId !== null);
  const productIds = [...new Set(linked.map((r) => r.productId!))];
  const adsProductIds = [...new Set(linked.map((r) => r.adsProductId!))];
  const firstAds = productIds.length ? ads.get(productIds[0]) : undefined;
  const mlPrice = ml.price;
  const e: PriceEvaluation = {
    itemId: rows[0].itemId,
    title: rows[0].title,
    variationIds: ml.variationIds,
    productIds,
    adsProductIds,
    adsPrice: firstAds?.price ?? null,
    adsUpdatedAt: firstAds?.updatedAt ?? null,
    branchId: firstAds?.branchId ?? null,
    marketplaceStatus: ml.status,
    marketplacePrice: mlPrice === null ? null : mlPrice.toFixed(2),
    proposedPrice: null,
    difference: null,
    changePct: null,
    largeChange: false,
    eligible: false,
    reasonCode: null,
    reason: null,
    status: "INELIGIBLE",
    needsPromotionCheck: false,
  };
  const block = (code: string, reason: string): PriceEvaluation => ({ ...e, eligible: false, reasonCode: code, reason, status: "INELIGIBLE" });

  if (!ml.found) return block("NOT_FOUND", "Anúncio não encontrado no Mercado Livre");
  if (!WRITABLE_STATUS.has(ml.status ?? "") || ml.subStatus.includes("deleted")) {
    return block("LISTING_NOT_ACTIVE", `Anúncio ${ml.status ?? "sem status"}: preço não é alterado`);
  }
  if (linked.length !== rows.length) return block("PARTIAL_LINK", "Nem todas as variações do anúncio estão vinculadas a um produto ADS");
  if (linked.some((r) => r.components > 0)) {
    return block("KIT", "Vínculo com composição (kit/pacote): o preço da ADS é de uma unidade, ajuste o preço no ML manualmente");
  }
  const prices = productIds.map((id) => ads.get(id));
  const err = prices.find((p) => !p || p.status === "ERROR");
  if (err) return block("ADS_ERROR", `Falha ao consultar o preço na ADS${err?.error ? `: ${err.error}` : ""}`);
  if (prices.some((p) => p!.status !== "KNOWN" || toCents(p!.price) === null || toCents(p!.price)! <= 0)) {
    return block("NO_ADS_PRICE", `Sem preço ativo na tabela ${settings.priceTableCode} da ADS${settings.branchId ? ` (filial ${settings.branchId})` : ""}`);
  }
  const distinct = [...new Set(prices.map((p) => toCents(p!.price)))];
  if (distinct.length > 1) return block("VARIATION_PRICES_DIFFER", "Variações vinculadas a produtos ADS com preços diferentes: o ML exige o mesmo preço");
  const target = distinct[0]!;
  const current = toCents(mlPrice);
  if (current === null) return block("NO_ML_PRICE", "O Mercado Livre não informou o preço atual");
  const varPrices = [...new Set(ml.variationPrices.map((p) => toCents(p)))];
  const remoteConsistent = !ml.variationIds.length || (varPrices.length === 1 && varPrices[0] === current);

  const diff = target - current;
  const pct = current > 0 ? (diff / current) * 100 : 100;
  const base = {
    ...e,
    proposedPrice: fromCents(target),
    difference: fromCents(diff),
    changePct: pct.toFixed(2),
    largeChange: Math.abs(pct) > settings.maxChangePct,
  };
  if (diff === 0 && remoteConsistent) return { ...base, eligible: true, status: "IN_SYNC" };
  return { ...base, eligible: true, status: "PROPOSED", needsPromotionCheck: true };
}

/** Lê /items/{id}/prices: há preço promocional vigente? */
export function hasActivePromotion(body: unknown, now = Date.now()): boolean {
  const prices = (body as { prices?: unknown[] } | null)?.prices;
  if (!Array.isArray(prices)) return false;
  return prices.some((raw) => {
    const p = raw as { type?: string; regular_amount?: number | null; conditions?: { start_time?: string | null; end_time?: string | null } };
    const promo = p?.type === "promotion" || (typeof p?.regular_amount === "number" && p.regular_amount > 0);
    if (!promo) return false;
    const start = p.conditions?.start_time ? Date.parse(p.conditions.start_time) : null;
    const end = p.conditions?.end_time ? Date.parse(p.conditions.end_time) : null;
    return (start === null || Number.isNaN(start) || start <= now) && (end === null || Number.isNaN(end) || end > now);
  });
}

/** Corpo da única escrita deste módulo: o preço (todas as variações recebem o mesmo valor — omitir uma a excluiria). */
export function buildPriceBody(variationIds: string[], price: string): Record<string, unknown> {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Preço inválido");
  return variationIds.length ? { variations: variationIds.map((id) => ({ id: Number(id), price: value })) } : { price: value };
}

// ---------------------------------------------------------------------------
// Leituras (ADS e ML)
// ---------------------------------------------------------------------------

async function loadLinkedRows(sql: Sql, itemIds?: string[]): Promise<LinkedRow[]> {
  return sql.query<LinkedRow>(
    `SELECT ll.marketplace_item_id AS "itemId", ll.variation_id AS "variationId", ll.title,
            m.product_id AS "productId", m.ads_product_id AS "adsProductId",
            (SELECT count(*)::int FROM marketplace_mapping_components c WHERE c.mapping_id = m.id) AS components
     FROM legacy_listings ll
     LEFT JOIN marketplace_product_mappings m ON m.active AND m.mapping_type = 'ITEM'
          AND m.marketplace_item_id = ll.marketplace_item_id AND m.variation_id = ll.variation_id
     WHERE ll.removed_at IS NULL AND ll.origin = 'EXTERNAL'
       AND ($1::text[] IS NULL OR ll.marketplace_item_id = ANY($1::text[]))
       AND EXISTS (SELECT 1 FROM marketplace_product_mappings m2 WHERE m2.active AND m2.mapping_type = 'ITEM' AND m2.marketplace_item_id = ll.marketplace_item_id)
     ORDER BY ll.marketplace_item_id, ll.variation_id`,
    [itemIds?.length ? itemIds : null],
  );
}

/** Preço ao vivo na ADS (o cache product_prices é atualizado como efeito colateral). Chave: products.id. */
export async function fetchAdsPrices(sql: Sql, productIds: number[], settings: PriceSyncSettings): Promise<Map<number, AdsPrice>> {
  const out = new Map<number, AdsPrice>();
  if (!productIds.length) return out;
  const products = await sql.query<{ id: number; adsProductId: number }>(`SELECT id, ads_product_id AS "adsProductId" FROM products WHERE id = ANY($1::int[])`, [productIds]);
  const client = getAdsClient();
  for (let i = 0; i < products.length; i += 20) {
    const chunk = products.slice(i, i + 20);
    const ids = chunk.map((p) => p.adsProductId);
    try {
      const items: unknown[] = [];
      for (let page = 1; page <= 20; page++) {
        let res;
        try {
          res = await client.getPage("tabela-precos-itens", { page, ids });
        } catch (err) {
          if (!(err instanceof AdsApiError && err.transient)) throw err;
          await retrySleep(Math.max(err.retryAfterMs ?? 0, 1_000));
          res = await client.getPage("tabela-precos-itens", { page, ids });
        }
        items.push(...res.items);
        if (!res.hasNext || !res.items.length) break;
      }
      const rows = mapPrices(items).rows.filter((r) => ids.includes(r.ads_product_id));
      await upsertPrices(sql, rows);
      for (const p of chunk) out.set(p.id, pickPrice(rows, p.adsProductId, settings));
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : "Erro na ADS";
      for (const p of chunk) out.set(p.id, { status: "ERROR", price: null, branchId: null, updatedAt: null, error: message });
    }
  }
  return out;
}

export function pickPrice(rows: PriceRow[], adsProductId: number, settings: PriceSyncSettings): AdsPrice {
  const candidates = rows
    .filter((r) => r.ads_product_id === adsProductId && r.price_table_code === settings.priceTableCode && !r.inactive && r.price !== null)
    .filter((r) => !settings.branchId || r.branch_id === settings.branchId)
    .sort((a, b) => a.branch_id.localeCompare(b.branch_id));
  const r = candidates[0];
  return r ? { status: "KNOWN", price: r.price, branchId: r.branch_id, updatedAt: r.ads_updated_at } : { status: "UNKNOWN", price: null, branchId: null, updatedAt: null };
}

interface MlItemPrice {
  id?: string;
  status?: string | null;
  sub_status?: string[] | null;
  price?: number | null;
  variations?: { id?: number | string; price?: number | null }[];
  shipping?: { logistic_type?: string | null } | null;
}

const ITEM_FIELDS = "id,status,sub_status,price,variations,shipping";

export async function readMlPrices(ids: string[]): Promise<Map<string, MlPriceState>> {
  const out = new Map<string, MlPriceState>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const { data } = await multigetItems<{ code: number; body: MlItemPrice }>(chunk, ITEM_FIELDS).then((data) => ({ data }));
    const byId = new Map<string, MlItemPrice>();
    for (const e of Array.isArray(data) ? data : []) if (e?.code === 200 && e.body?.id) byId.set(e.body.id, e.body);
    for (const id of chunk) {
      const it = byId.get(id);
      const vars = Array.isArray(it?.variations) ? it!.variations! : [];
      out.set(
        id,
        it
          ? {
              found: true,
              status: it.status ?? null,
              subStatus: Array.isArray(it.sub_status) ? it.sub_status.map(String) : [],
              price: typeof it.price === "number" ? it.price : null,
              variationIds: vars.map((v) => String(v.id)),
              variationPrices: vars.map((v) => (typeof v.price === "number" ? v.price : null)),
              logisticType: it.shipping?.logistic_type ?? null,
            }
          : { found: false, status: "not_found", subStatus: [], price: null, variationIds: [], variationPrices: [], logisticType: null },
      );
    }
  }
  return out;
}

async function promotionActive(itemId: string): Promise<boolean> {
  const { data } = await withReadRetry(() => meliRequest<unknown>(`/items/${encodeURIComponent(itemId)}/prices`, { auth: true }));
  return hasActivePromotion(data);
}

// ---------------------------------------------------------------------------
// Simulação
// ---------------------------------------------------------------------------

export interface PricePreviewResult {
  runId: string;
  status: "COMPLETED" | "PARTIAL";
  summary: { proposed: number; inSync: number; ineligible: number; largeChange: number; items: number; scope?: "ITEMS" };
  /** Propostas geradas (somente quando a simulação foi restrita a anúncios específicos). */
  proposals: PriceProposalView[];
}

const timeLeft = (deadline?: number) => (deadline === undefined ? Infinity : deadline - Date.now());

function groupByItem(rows: LinkedRow[]): Map<string, LinkedRow[]> {
  const m = new Map<string, LinkedRow[]>();
  for (const r of rows) m.set(r.itemId, [...(m.get(r.itemId) ?? []), r]);
  return m;
}

export async function runPricePreview(sql: Sql, opts: { requestedBy: string; itemIds?: string[]; deadline?: number }): Promise<PricePreviewResult> {
  const settings = await getPriceSettings(sql);
  const [{ id: runId }] = await sql.query<{ id: string }>(
    `INSERT INTO price_sync_runs (requested_by, price_table_code, branch_id) VALUES ($1::text, $2::text, $3::text) RETURNING id::text AS id`,
    [opts.requestedBy, settings.priceTableCode, settings.branchId],
  );
  const scoped = !!opts.itemIds?.length;
  const summary: PricePreviewResult["summary"] = { proposed: 0, inSync: 0, ineligible: 0, largeChange: 0, items: 0, ...(scoped ? { scope: "ITEMS" as const } : {}) };
  let partial = false;
  try {
    const byItem = groupByItem(await loadLinkedRows(sql, opts.itemIds));
    const itemIds = [...byItem.keys()];
    for (let i = 0; i < itemIds.length; i += 40) {
      if (timeLeft(opts.deadline) < 8_000) {
        partial = true;
        break;
      }
      const chunk = itemIds.slice(i, i + 40);
      const productIds = [...new Set(chunk.flatMap((id) => byItem.get(id)!.map((r) => r.productId).filter((v): v is number => v !== null)))];
      const [ads, ml] = await Promise.all([fetchAdsPrices(sql, productIds, settings), readMlPrices(chunk)]);
      for (const itemId of chunk) {
        let ev = evaluatePrice(byItem.get(itemId)!, ads, ml.get(itemId)!, settings);
        if (ev.needsPromotionCheck) {
          try {
            if (await promotionActive(itemId)) {
              ev = { ...ev, eligible: false, status: "INELIGIBLE", reasonCode: "PROMOTION_ACTIVE", reason: "Anúncio em promoção no ML: alterar o preço pode encerrar a promoção" };
            }
          } catch (err) {
            ev = { ...ev, eligible: false, status: "INELIGIBLE", reasonCode: "PROMOTION_UNKNOWN", reason: `Não foi possível verificar promoções no ML (${err instanceof Error ? err.message.slice(0, 120) : "erro"})` };
          }
        }
        await insertProposal(sql, runId, settings, ev);
        summary.items++;
        if (ev.status === "PROPOSED") summary.proposed++;
        else if (ev.status === "IN_SYNC") summary.inSync++;
        else summary.ineligible++;
        if (ev.status === "PROPOSED" && ev.largeChange) summary.largeChange++;
      }
    }
    const status = partial ? "PARTIAL" : "COMPLETED";
    await sql.execute(`UPDATE price_sync_runs SET status = $2::text, summary = $3::jsonb, finished_at = now() WHERE id = $1::uuid`, [runId, status, JSON.stringify(summary)]);
    return { runId, status, summary, proposals: scoped ? await getPriceProposals(sql, runId) : [] };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "Erro desconhecido";
    await sql.execute(`UPDATE price_sync_runs SET status = 'FAILED', error_message = $2::text, summary = $3::jsonb, finished_at = now() WHERE id = $1::uuid`, [runId, message, JSON.stringify(summary)]);
    throw err;
  }
}

async function insertProposal(sql: Sql, runId: string, settings: PriceSyncSettings, e: PriceEvaluation) {
  // Propostas abertas anteriores do mesmo anúncio deixam de valer (só a mais recente pode ser aplicada).
  await sql.execute(
    `UPDATE price_sync_proposals SET status = 'STALE', error_message = 'Substituída por simulação mais recente', updated_at = now()
     WHERE marketplace_item_id = $1::text AND status = 'PROPOSED'`,
    [e.itemId],
  );
  await sql.execute(
    `INSERT INTO price_sync_proposals (run_id, marketplace_item_id, title, variation_ids, product_ids, ads_product_ids, price_table_code, branch_id,
       ads_price, ads_updated_at, marketplace_status, marketplace_price, proposed_price, difference, change_pct, large_change, eligible, reason_code, reason, status)
     VALUES ($1::uuid, $2::text, $3::text, $4::text[], $5::int[], $6::int[], $7::text, $8::text, $9::numeric, $10::timestamptz, $11::text, $12::numeric,
       $13::numeric, $14::numeric, $15::numeric, $16::boolean, $17::boolean, $18::text, $19::text, $20::text)`,
    [
      runId, e.itemId, e.title, e.variationIds, e.productIds, e.adsProductIds, settings.priceTableCode, e.branchId,
      e.adsPrice, e.adsUpdatedAt, e.marketplaceStatus, e.marketplacePrice, e.proposedPrice, e.difference, e.changePct, e.largeChange, e.eligible, e.reasonCode, e.reason, e.status,
    ],
  );
}

// ---------------------------------------------------------------------------
// Consultas para a tela
// ---------------------------------------------------------------------------

export interface PriceProposalView {
  id: string;
  runId: string;
  marketplaceItemId: string;
  title: string | null;
  variationIds: string[];
  adsProductIds: number[];
  priceTableCode: string;
  branchId: string | null;
  adsPrice: string | null;
  marketplaceStatus: string | null;
  marketplacePrice: string | null;
  proposedPrice: string | null;
  difference: string | null;
  changePct: string | null;
  largeChange: boolean;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  status: string;
  appliedBy: string | null;
  appliedAt: Date | null;
  appliedPrice: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

const PROPOSAL_SELECT = `SELECT id::text AS id, run_id::text AS "runId", marketplace_item_id AS "marketplaceItemId", title, variation_ids AS "variationIds",
  ads_product_ids AS "adsProductIds", price_table_code AS "priceTableCode", branch_id AS "branchId", ads_price::text AS "adsPrice",
  marketplace_status AS "marketplaceStatus", marketplace_price::text AS "marketplacePrice", proposed_price::text AS "proposedPrice",
  difference::text AS difference, change_pct::text AS "changePct", large_change AS "largeChange", eligible, reason_code AS "reasonCode", reason, status,
  applied_by AS "appliedBy", applied_at AS "appliedAt", applied_price::text AS "appliedPrice", error_message AS "errorMessage", created_at AS "createdAt"
  FROM price_sync_proposals`;

export async function latestPriceRun(sql: Sql) {
  const [run] = await sql.query<{ id: string; status: string; requestedBy: string; priceTableCode: string; startedAt: Date; summary: unknown }>(
    `SELECT id::text AS id, status, requested_by AS "requestedBy", price_table_code AS "priceTableCode", started_at AS "startedAt", summary
     FROM price_sync_runs WHERE summary IS NULL OR summary->>'scope' IS DISTINCT FROM 'ITEMS' ORDER BY started_at DESC LIMIT 1`,
  );
  return run ?? null;
}

export async function getPriceProposals(sql: Sql, runId: string): Promise<PriceProposalView[]> {
  return sql.query<PriceProposalView>(
    `${PROPOSAL_SELECT} WHERE run_id = $1::uuid
     ORDER BY CASE status WHEN 'PROPOSED' THEN 0 WHEN 'INELIGIBLE' THEN 2 WHEN 'IN_SYNC' THEN 3 ELSE 1 END, abs(COALESCE(change_pct, 0)) DESC, id`,
    [runId],
  );
}

export async function listPriceApplications(sql: Sql, limit = 30): Promise<PriceProposalView[]> {
  return sql.query<PriceProposalView>(`${PROPOSAL_SELECT} WHERE applied_at IS NOT NULL ORDER BY applied_at DESC LIMIT $1::int`, [limit]);
}

// ---------------------------------------------------------------------------
// Aplicação (escrita no ML)
// ---------------------------------------------------------------------------

export const PRICE_PROPOSAL_TTL_MINUTES = 30;

export interface PriceApplyResult {
  results: { proposalId: string; itemId: string; status: string; message: string | null }[];
  notProcessed: string[];
}

interface ClaimedProposal {
  id: string;
  runId: string;
  itemId: string;
  variationIds: string[];
  productIds: number[];
  adsPrice: string;
  marketplacePrice: string;
  proposedPrice: string;
  largeChange: boolean;
}

async function finish(
  sql: Sql,
  id: string,
  status: "APPLIED" | "DIVERGED" | "FAILED" | "STALE",
  f: { actor: string; appliedPrice?: string | null; httpStatus?: number | null; request?: unknown; response?: unknown; error?: string | null },
) {
  await sql.execute(
    `UPDATE price_sync_proposals SET status = $2::text, applied_by = $3::text, applied_at = now(), applied_price = $4::numeric, http_status = $5::int,
       request = $6::jsonb, response = $7::jsonb, error_message = $8::text, updated_at = now() WHERE id = $1::bigint`,
    [
      id, status, f.actor, f.appliedPrice ?? null, f.httpStatus ?? null,
      f.request === undefined ? null : JSON.stringify(f.request), f.response === undefined ? null : JSON.stringify(sanitize(f.response)), f.error ?? null,
    ],
  );
}

/**
 * Aplica as propostas escolhidas. Cada uma é reservada atomicamente (PROPOSED → APPLYING), reconferida na ADS e
 * no ML (preço e promoção) e só então escrita. Propostas que não couberem no tempo continuam PROPOSED.
 */
export async function applyPriceProposals(
  sql: Sql,
  opts: { proposalIds: string[]; actor: string; allowLargeChanges: boolean; deadline?: number },
): Promise<PriceApplyResult> {
  const settings = await getPriceSettings(sql);
  const results: PriceApplyResult["results"] = [];
  const notProcessed: string[] = [];
  const rows = await sql.query<ClaimedProposal & { status: string; eligible: boolean; createdAt: Date; priceTableCode: string }>(
    `SELECT id::text AS id, run_id::text AS "runId", marketplace_item_id AS "itemId", variation_ids AS "variationIds", product_ids AS "productIds",
            ads_price::text AS "adsPrice", marketplace_price::text AS "marketplacePrice", proposed_price::text AS "proposedPrice",
            large_change AS "largeChange", status, eligible, created_at AS "createdAt", price_table_code AS "priceTableCode"
     FROM price_sync_proposals WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [opts.proposalIds],
  );

  // Reconsulta da ADS em lote para as propostas válidas.
  const valid = rows.filter((r) => r.status === "PROPOSED" && r.eligible);
  const freshAds = await fetchAdsPrices(sql, [...new Set(valid.flatMap((r) => r.productIds))], settings);
  const freshMl = await readMlPrices([...new Set(valid.map((r) => r.itemId))]);

  for (const r of rows) {
    const out = (status: string, message: string | null) => results.push({ proposalId: r.id, itemId: r.itemId, status, message });
    if (r.status !== "PROPOSED" || !r.eligible) {
      out("SKIPPED", `Proposta não aplicável (${r.status.toLowerCase()})`);
      continue;
    }
    if (timeLeft(opts.deadline) < 6_000) {
      notProcessed.push(r.id);
      continue;
    }
    if (r.largeChange && !opts.allowLargeChanges) {
      out("SKIPPED", `Variação acima de ${settings.maxChangePct}%: exige confirmação adicional`);
      continue;
    }
    const [claimed] = await sql.query<{ id: string }>(
      `UPDATE price_sync_proposals SET status = 'APPLYING', updated_at = now() WHERE id = $1::bigint AND status = 'PROPOSED' RETURNING id::text AS id`,
      [r.id],
    );
    if (!claimed) {
      out("SKIPPED", "Proposta já em aplicação ou aplicada");
      continue;
    }
    const stale = async (msg: string) => {
      await finish(sql, r.id, "STALE", { actor: opts.actor, error: msg });
      out("STALE", msg);
    };
    try {
      if (r.priceTableCode !== settings.priceTableCode) {
        await stale("A tabela de preço configurada mudou desde a simulação");
        continue;
      }
      if (Date.now() - new Date(r.createdAt).getTime() > PRICE_PROPOSAL_TTL_MINUTES * 60_000) {
        await stale(`Simulação com mais de ${PRICE_PROPOSAL_TTL_MINUTES} minutos: simule de novo`);
        continue;
      }
      const adsNow = r.productIds.map((id) => freshAds.get(id));
      if (adsNow.some((a) => !a || a.status !== "KNOWN" || toCents(a.price) !== toCents(r.proposedPrice))) {
        await stale("O preço na ADS mudou ou não pôde ser reconsultado: simule de novo");
        continue;
      }
      const ml = freshMl.get(r.itemId);
      if (!ml?.found || !WRITABLE_STATUS.has(ml.status ?? "")) {
        await stale(`Anúncio não está ativo/pausado no ML (${ml?.status ?? "não encontrado"})`);
        continue;
      }
      if (toCents(ml.price) !== toCents(r.marketplacePrice)) {
        await stale(`O preço no ML mudou desde a simulação (agora R$ ${ml.price?.toFixed(2) ?? "?"}): simule de novo`);
        continue;
      }
      if (ml.variationIds.join(",") !== r.variationIds.join(",")) {
        await stale("As variações do anúncio mudaram desde a simulação");
        continue;
      }
      if (await promotionActive(r.itemId)) {
        await stale("O anúncio entrou em promoção no ML: preço não alterado");
        continue;
      }

      const body = buildPriceBody(r.variationIds, r.proposedPrice);
      let httpStatus: number | null = null;
      let response: unknown = null;
      let writeError: string | null = null;
      try {
        const res = await meliRequest(`/items/${encodeURIComponent(r.itemId)}`, { method: "PUT", auth: true, body, timeoutMs: 15_000 });
        httpStatus = res.status;
        response = { price: (res.data as { price?: unknown })?.price ?? null };
      } catch (err) {
        if (err instanceof MeliHttpError) {
          httpStatus = err.status;
          response = err.body ?? null;
          writeError = err.message;
          if (err.definitelyNotProcessed) {
            await finish(sql, r.id, "FAILED", { actor: opts.actor, httpStatus, request: body, response, error: err.message.slice(0, 500) });
            out("FAILED", err.message.slice(0, 300));
            continue;
          }
        } else {
          writeError = err instanceof Error ? err.message : "Erro desconhecido";
        }
        // Resultado incerto (timeout/5xx): a conferência abaixo decide.
      }

      const after = (await readMlPrices([r.itemId])).get(r.itemId);
      const applied = after?.price ?? null;
      const ok = toCents(applied) === toCents(r.proposedPrice);
      await finish(sql, r.id, ok ? "APPLIED" : "DIVERGED", {
        actor: opts.actor,
        appliedPrice: applied === null ? null : applied.toFixed(2),
        httpStatus,
        request: body,
        response,
        error: ok ? null : `Preço no ML depois da escrita: ${applied ?? "?"}${writeError ? ` (${writeError.slice(0, 200)})` : ""}`,
      });
      if (ok) {
        await sql.execute(`UPDATE legacy_listings SET price = $2::numeric WHERE marketplace_item_id = $1::text`, [r.itemId, r.proposedPrice]);
      }
      await recordHistory(sql, {
        type: ok ? "PRICE_APPLIED" : "PRICE_DIVERGED",
        actor: opts.actor,
        itemId: r.itemId,
        productId: r.productIds[0] ?? null,
        details: { proposalId: r.id, before: r.marketplacePrice, target: r.proposedPrice, after: applied, table: settings.priceTableCode },
      }).catch((err) => logger.warn("Falha ao registrar histórico de preço", { err }));
      out(ok ? "APPLIED" : "DIVERGED", ok ? null : `Preço no ML ficou ${applied ?? "?"}`);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "Erro desconhecido";
      await finish(sql, r.id, "FAILED", { actor: opts.actor, error: message }).catch(() => undefined);
      out("FAILED", message);
    }
  }
  return { results, notProcessed };
}
