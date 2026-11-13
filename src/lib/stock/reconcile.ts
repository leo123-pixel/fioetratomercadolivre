import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { adsEnvironment, adsUnavailable, getAllPagesForIds, isAdsOutage, type PagedReadOptions } from "../ads/client";
import { adsHoursState } from "../ads/hours";
import { mapStocks } from "../ads/schemas";
import { getEnv } from "../env";
import { acquireLease, releaseLease } from "../imports/jobs";
import { upsertStocks } from "../imports/upserts";
import { logger, sanitize } from "../logger";
import { raiseAlert } from "../marketplace/alerts";
import { backoffMs, classifyError, retrySleep } from "../marketplace/errors";
import { MeliHttpError } from "../meli/api";
import { MeliAuthError } from "../meli/tokens";
import { isUniqueViolation, type Sql } from "../sql";
import { POOL_KEY_SQL } from "./legacy";
import { buildWrite, executeWrite, readRemoteState, type PoolRef, type RemoteState, type StockModel } from "./remote";
import { autoSyncState, getGroupPolicies, getStockSettings, recordHistory, StockSyncError, type GroupPolicy, type StockSyncSettings } from "./settings";

/**
 * StockReconciliationService — compara o saldo da ADS (fonte de verdade do estoque próprio) com o estoque
 * anunciado no Mercado Livre e propõe/aplica a quantidade anunciável:
 *
 *   disponível(P)  = max(0, ⌊saldo ADS(P)⌋ − reserva(P) − ⌈pedidos ML ainda não refletidos na ADS(P)⌉)
 *   parcela(P, E)  = disponível(P)                         se P abastece um único estoque E do ML
 *                  = ⌊disponível(P) / nº de estoques⌋      se a política do produto for SPLIT_EVEN
 *                  = bloqueado (ALLOCATION_REQUIRED)        caso contrário — nunca copia o saldo para vários anúncios
 *   anunciável(E)  = min sobre os componentes C do vínculo de ⌊parcela(C, E) / qtd(C)⌋, limitado por max_quantity
 *
 * "Estoque E" (pool) é o que o ML controla de fato: anúncios do mesmo User Product compartilham um estoque;
 * sem User Product, cada anúncio (ou variação) tem o seu. Ausência de saldo na ADS NUNCA vira zero.
 * A única escrita no ML é a quantidade (nunca preço, título, imagens, categoria ou descrição).
 */

export interface Component {
  productId: number;
  adsProductId: number;
  quantity: number;
}

interface PoolRow {
  rowId: string;
  itemId: string;
  variationId: string;
  userProductId: string | null;
  status: string | null;
  logisticType: string | null;
  availableQuantity: number | null;
  lastSeenAt: Date;
  title: string | null;
  poolKey: string;
  linkSource: "EXISTING_LINK" | "MAPPING" | null;
  productId: number | null;
  adsProductId: number | null;
  mappingId: string | null;
  maxQuantity: number | null;
  components: Component[] | null;
}

export interface Pool extends PoolRef {
  title: string | null;
  rows: PoolRow[];
  components: Component[] | null;
  compositionError: string | null;
  maxQuantity: number | null;
  /** Consome saldo físico da ADS (vigente e fora do Full) — entra na divisão do estoque. */
  consumer: boolean;
}

export async function loadPools(sql: Sql): Promise<Pool[]> {
  const rows = await sql.query<PoolRow>(
    `SELECT ll.id::text AS "rowId", ll.marketplace_item_id AS "itemId", ll.variation_id AS "variationId", ll.user_product_id AS "userProductId",
            ll.status, ll.logistic_type AS "logisticType", ll.available_quantity AS "availableQuantity", ll.last_seen_at AS "lastSeenAt",
            ll.title, ${POOL_KEY_SQL("ll")} AS "poolKey",
            CASE WHEN il.id IS NOT NULL THEN 'EXISTING_LINK' WHEN m.id IS NOT NULL THEN 'MAPPING' END AS "linkSource",
            COALESCE(il.product_id, m.product_id) AS "productId", COALESCE(il.ads_product_id, m.ads_product_id) AS "adsProductId",
            m.id::text AS "mappingId", m.max_quantity AS "maxQuantity",
            (SELECT json_agg(json_build_object('productId', c.product_id, 'adsProductId', c.ads_product_id, 'quantity', c.quantity) ORDER BY c.product_id)
             FROM marketplace_mapping_components c WHERE c.mapping_id = m.id) AS components
     FROM legacy_listings ll
     LEFT JOIN LATERAL (SELECT l.id, l.product_id, l.ads_product_id FROM marketplace_listings l
                        WHERE l.marketplace_item_id = ll.marketplace_item_id AND l.status <> 'deleted' ORDER BY l.id DESC LIMIT 1) il ON true
     LEFT JOIN marketplace_product_mappings m ON il.id IS NULL AND m.active AND m.mapping_type = 'ITEM'
          AND m.marketplace_item_id = ll.marketplace_item_id AND m.variation_id = ll.variation_id
     WHERE ll.removed_at IS NULL
     ORDER BY ll.id`,
  );
  const byKey = new Map<string, PoolRow[]>();
  for (const r of rows) byKey.set(r.poolKey, [...(byKey.get(r.poolKey) ?? []), r]);
  const pools: Pool[] = [];
  for (const [key, list] of byKey) {
    const compOf = (r: PoolRow): Component[] | null =>
      r.components?.length ? r.components : r.productId && r.adsProductId ? [{ productId: r.productId, adsProductId: r.adsProductId, quantity: 1 }] : null;
    const linked = list.filter((r) => compOf(r));
    const signatures = new Set(linked.map((r) => JSON.stringify(compOf(r))));
    const components = linked.length ? compOf(linked[0]) : null;
    const caps = linked.map((r) => r.maxQuantity).filter((v): v is number => v !== null);
    const variationId = key.startsWith("item:") && key.split(":").length === 3 ? key.split(":")[2] : "";
    pools.push({
      key,
      itemIds: [...new Set(list.map((r) => r.itemId))],
      variationId,
      userProductId: list[0].userProductId && key.startsWith("up:") ? list[0].userProductId : null,
      title: list[0].title,
      rows: list,
      components,
      compositionError: signatures.size > 1 ? "Anúncios que compartilham o mesmo estoque estão vinculados a produtos ou composições diferentes" : null,
      maxQuantity: caps.length ? Math.min(...caps) : null,
      consumer: false,
    });
  }
  for (const p of pools) {
    p.consumer = !!p.components && !p.compositionError && p.rows.some((r) => (r.status === "active" || r.status === "paused") && r.logisticType !== "fulfillment");
  }
  return pools;
}

// ---------------------------------------------------------------------------
// Saldo da ADS (consulta ao vivo; o cache product_stocks é atualizado como efeito colateral).
// ---------------------------------------------------------------------------

export interface AdsStock {
  status: "KNOWN" | "UNKNOWN" | "ERROR";
  quantity: number | null;
  branches: { branchId: string; quantity: number }[];
  fetchedAt: Date;
  error?: string;
}

export async function fetchAdsStocks(sql: Sql, productIds: number[], settings: StockSyncSettings, opts: PagedReadOptions = {}): Promise<Map<number, AdsStock>> {
  const out = new Map<number, AdsStock>();
  if (!productIds.length) return out;
  const products = await sql.query<{ id: number; adsProductId: number }>(`SELECT id, ads_product_id AS "adsProductId" FROM products WHERE id = ANY($1::int[])`, [productIds]);
  // Depois de uma queda/sem tempo, os lotes seguintes não são tentados (cada um esperaria o timeout de novo).
  let stopped: string | null = null;
  for (let i = 0; i < products.length; i += 20) {
    const chunk = products.slice(i, i + 20);
    const ids = chunk.map((p) => p.adsProductId);
    const fetchedAt = new Date();
    try {
      if (stopped) throw new Error(stopped);
      const items = await getAllPagesForIds("estoques", ids, opts);
      const mapped = mapStocks(items);
      const rows = mapped.rows.filter((r) => ids.includes(r.ads_product_id));
      await upsertStocks(sql, rows);
      for (const p of chunk) {
        const branches = rows
          .filter((r) => r.ads_product_id === p.adsProductId && (!settings.branchIds || settings.branchIds.includes(r.branch_id)))
          .map((r) => ({ branchId: r.branch_id, quantity: Number(r.quantity) }));
        out.set(
          p.id,
          branches.length
            ? { status: "KNOWN", quantity: branches.reduce((a, b) => a + b.quantity, 0), branches, fetchedAt }
            : { status: "UNKNOWN", quantity: null, branches: [], fetchedAt },
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : "Erro na ADS";
      if (isAdsOutage(err)) stopped = message;
      for (const p of chunk) out.set(p.id, { status: "ERROR", quantity: null, branches: [], fetchedAt, error: message });
    }
  }
  return out;
}

/**
 * Unidades vendidas no ML ainda não refletidas na ADS: linhas mapeadas de pedidos não cancelados, na janela,
 * sem envio confirmado (SENT) à ADS deste ambiente. Kits consomem cada componente × quantidade.
 */
export async function pendingConsumption(sql: Sql, productIds: number[], windowDays: number): Promise<Map<number, number>> {
  if (!productIds.length) return new Map();
  let environment = "producao";
  try {
    environment = adsEnvironment().environment;
  } catch {
    /* configuração ausente: considera produção (mais conservador: só envios de produção contam como baixados) */
  }
  const rows = await sql.query<{ productId: number; qty: string }>(
    `WITH lines AS (
       SELECT i.quantity, i.product_id, i.mapping_id FROM marketplace_order_items i
       JOIN marketplace_order_inbox o ON o.id = i.order_id
       WHERE i.mapping_status = 'MAPPED' AND COALESCE(o.order_status, '') NOT IN ('cancelled', 'invalid')
         AND COALESCE(o.date_created, o.received_at) > now() - make_interval(days => $2::int)
         AND NOT EXISTS (SELECT 1 FROM ads_order_submissions s WHERE s.order_id = o.id AND s.status = 'SENT' AND s.environment = $3::text)
     )
     SELECT comp.product_id AS "productId", sum(l.quantity * comp.qty)::text AS qty
     FROM lines l
     CROSS JOIN LATERAL (
       SELECT c.product_id, c.quantity AS qty FROM marketplace_mapping_components c WHERE c.mapping_id = l.mapping_id
       UNION ALL
       SELECT l.product_id, 1 WHERE NOT EXISTS (SELECT 1 FROM marketplace_mapping_components c WHERE c.mapping_id = l.mapping_id)
     ) comp
     WHERE comp.product_id = ANY($1::int[])
     GROUP BY comp.product_id`,
    [productIds, windowDays, environment],
  );
  return new Map(rows.map((r) => [r.productId, Number(r.qty)]));
}

/** Sinais de venda que a ADS pode ainda não conhecer (por anúncio). */
async function saleSignals(sql: Sql, itemIds: string[], windowDays: number): Promise<Map<string, { unmapped: number; lastOrderAt: Date | null }>> {
  if (!itemIds.length) return new Map();
  const rows = await sql.query<{ itemId: string; unmapped: number; lastOrderAt: Date | null }>(
    `SELECT i.marketplace_item_id AS "itemId",
            count(*) FILTER (WHERE i.mapping_status = 'UNMAPPED' AND COALESCE(o.order_status, '') NOT IN ('cancelled', 'invalid'))::int AS unmapped,
            max(COALESCE(o.date_created, o.received_at)) AS "lastOrderAt"
     FROM marketplace_order_items i JOIN marketplace_order_inbox o ON o.id = i.order_id
     WHERE i.marketplace_item_id = ANY($1::text[]) AND COALESCE(o.date_created, o.received_at) > now() - make_interval(days => $2::int)
     GROUP BY 1`,
    [itemIds, windowDays],
  );
  return new Map(rows.map((r) => [r.itemId, { unmapped: r.unmapped, lastOrderAt: r.lastOrderAt ? new Date(r.lastOrderAt) : null }]));
}

/** Vendas muito recentes: aumento de estoque espera a ADS refletir. */
export const SALE_SETTLE_MINUTES = 10;

// ---------------------------------------------------------------------------
// Avaliação de um pool.
// ---------------------------------------------------------------------------

export type Direction = "INCREASE" | "DECREASE" | "NONE";

export interface ComponentCalc {
  productId: number;
  adsProductId: number;
  perSale: number;
  adsStatus: AdsStock["status"];
  adsQuantity: number | null;
  branches: { branchId: string; quantity: number }[];
  reserve: number;
  pending: number;
  available: number | null;
  consumers: number;
  allocationMode: string;
  share: number | null;
  units: number | null;
}

export interface Evaluation {
  pool: Pool;
  state: RemoteState | null;
  stockModel: StockModel;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  adsQuantity: number | null;
  safetyReserve: number | null;
  pendingOrders: number | null;
  marketplaceQuantity: number | null;
  proposedQuantity: number | null;
  difference: number | null;
  direction: Direction | null;
  adsFetchedAt: Date | null;
  calculation: Record<string, unknown>;
}

interface Context {
  settings: StockSyncSettings;
  ads: Map<number, AdsStock>;
  pending: Map<number, number>;
  policies: Map<number, GroupPolicy>;
  consumers: Map<number, Set<string>>;
  signals: Map<string, { unmapped: number; lastOrderAt: Date | null }>;
}

async function buildContext(sql: Sql, selected: Pool[], all: Pool[], settings: StockSyncSettings, adsOpts: PagedReadOptions = {}): Promise<Context> {
  const consumers = new Map<number, Set<string>>();
  for (const p of all) {
    if (!p.consumer) continue;
    for (const c of p.components!) consumers.set(c.productId, (consumers.get(c.productId) ?? new Set()).add(p.key));
  }
  const productIds = [...new Set(selected.flatMap((p) => (p.components ?? []).map((c) => c.productId)))];
  const [ads, pending, policies, signals] = await Promise.all([
    fetchAdsStocks(sql, productIds, settings, adsOpts),
    pendingConsumption(sql, productIds, settings.pendingOrderWindowDays),
    getGroupPolicies(sql, productIds),
    saleSignals(
      sql,
      [...new Set(selected.flatMap((p) => p.itemIds))],
      settings.pendingOrderWindowDays,
    ),
  ]);
  return { settings, ads, pending, policies, consumers, signals };
}

function fail(e: Evaluation, code: string, reason: string): Evaluation {
  return { ...e, eligible: false, reasonCode: code, reason };
}

async function evaluatePool(pool: Pool, ctx: Context): Promise<Evaluation> {
  let e: Evaluation = {
    pool,
    state: null,
    stockModel: "UNKNOWN",
    eligible: false,
    reasonCode: null,
    reason: null,
    adsQuantity: null,
    safetyReserve: null,
    pendingOrders: null,
    marketplaceQuantity: null,
    proposedQuantity: null,
    difference: null,
    direction: null,
    adsFetchedAt: null,
    calculation: {},
  };
  if (!pool.components) return fail(e, "NOT_LINKED", "Anúncio sem vínculo com produto ADS");
  if (pool.compositionError) return fail(e, "AMBIGUOUS_GROUP", pool.compositionError);

  // 1. Saldo ADS e alocação por componente.
  const comps: ComponentCalc[] = [];
  let blocked: { code: string; reason: string } | null = null;
  for (const c of pool.components) {
    const ads = ctx.ads.get(c.productId);
    const policy = ctx.policies.get(c.productId);
    const reserve = policy?.safetyReserve ?? ctx.settings.defaultSafetyReserve;
    const pending = ctx.pending.get(c.productId) ?? 0;
    const consumers = Math.max(ctx.consumers.get(c.productId)?.size ?? 0, 1);
    const mode = policy?.allocationMode ?? "EXCLUSIVE";
    const calc: ComponentCalc = {
      productId: c.productId,
      adsProductId: c.adsProductId,
      perSale: c.quantity,
      adsStatus: ads?.status ?? "ERROR",
      adsQuantity: ads?.quantity ?? null,
      branches: ads?.branches ?? [],
      reserve,
      pending,
      available: null,
      consumers,
      allocationMode: mode,
      share: null,
      units: null,
    };
    comps.push(calc);
    if (!ads || ads.status === "ERROR") {
      blocked ??= { code: "ADS_ERROR", reason: `Falha ao consultar o saldo na ADS (produto ${c.adsProductId})${ads?.error ? `: ${ads.error}` : ""}` };
      continue;
    }
    if (ads.status === "UNKNOWN" || ads.quantity === null) {
      blocked ??= { code: "ADS_STOCK_UNKNOWN", reason: `Saldo não encontrado na ADS para o produto ${c.adsProductId} (não é tratado como zero)` };
      continue;
    }
    calc.available = Math.max(0, Math.floor(ads.quantity) - reserve - Math.ceil(pending));
    if (consumers > 1 && mode !== "SPLIT_EVEN") {
      blocked ??= {
        code: "ALLOCATION_REQUIRED",
        reason: `Produto ADS ${c.adsProductId} abastece ${consumers} estoques independentes no ML: defina a regra de alocação do grupo`,
      };
      continue;
    }
    calc.share = consumers > 1 ? Math.floor(calc.available / consumers) : calc.available;
    calc.units = Math.floor(calc.share / c.quantity);
  }
  const fetchedTimes = comps.map((c) => ctx.ads.get(c.productId)?.fetchedAt).filter((d): d is Date => !!d);
  e.adsFetchedAt = fetchedTimes.length ? new Date(Math.min(...fetchedTimes.map((d) => d.getTime()))) : null;
  if (comps.length === 1) {
    e.adsQuantity = comps[0].adsQuantity;
    e.safetyReserve = comps[0].reserve;
    e.pendingOrders = comps[0].pending;
  }
  let proposed: number | null = null;
  if (!blocked) {
    proposed = Math.min(...comps.map((c) => c.units!));
    if (pool.maxQuantity !== null) proposed = Math.min(proposed, pool.maxQuantity);
  }
  e.proposedQuantity = proposed;
  e.calculation = { components: comps, maxQuantity: pool.maxQuantity, formula: "max(0, ⌊ADS⌋ − reserva − ⌈pedidos pendentes⌉) ÷ estoques ÷ qtd por venda" };

  // 2. Estado remoto e modelo de estoque (sempre lido, para exibir o que existe no ML).
  try {
    e.state = await readRemoteState(pool);
  } catch (err) {
    if (err instanceof MeliAuthError || (err instanceof MeliHttpError && (err.kind === "auth" || err.kind === "forbidden"))) throw err;
    const c = classifyError(err);
    return fail(e, "REMOTE_ERROR", `Falha ao consultar o Mercado Livre: ${c.message}`);
  }
  e.stockModel = e.state.model;
  e.marketplaceQuantity = e.state.quantity;
  e.calculation = {
    ...e.calculation,
    stockModel: e.state.model,
    remoteVersion: e.state.version,
    locations: e.state.locations,
    items: e.state.items.map((i) => ({ itemId: i.itemId, status: i.status, subStatus: i.subStatus, logisticType: i.logisticType })),
  };
  if (proposed !== null && e.marketplaceQuantity !== null) {
    e.difference = proposed - e.marketplaceQuantity;
    e.direction = e.difference > 0 ? "INCREASE" : e.difference < 0 ? "DECREASE" : "NONE";
  }
  if (!e.state.writable) return fail(e, e.state.reasonCode ?? "NOT_WRITABLE", e.state.reason ?? "Estoque não gerenciável pela API");
  if (blocked) return fail(e, blocked.code, blocked.reason);

  // 3. Proteções contra estoque inflado (somente para aumento).
  if (e.direction === "INCREASE") {
    if (e.state.manualPause) return fail(e, "PAUSED_MANUALLY", "Anúncio pausado manualmente: o integrador não aumenta o estoque (só reduz)");
    const age = e.adsFetchedAt ? (Date.now() - e.adsFetchedAt.getTime()) / 60_000 : Infinity;
    if (age > ctx.settings.maxStockAgeMinutes) return fail(e, "ADS_STOCK_STALE", `Saldo ADS com ${Math.round(age)} min (máximo ${ctx.settings.maxStockAgeMinutes} min para aumentar)`);
    const sig = pool.itemIds.map((id) => ctx.signals.get(id)).filter((s): s is { unmapped: number; lastOrderAt: Date | null } => !!s);
    if (sig.some((s) => s.unmapped > 0)) return fail(e, "UNMAPPED_RECENT_ORDERS", "Há pedidos recentes deste anúncio sem produto ADS: o saldo vendável não pode ser confirmado");
    const last = Math.max(0, ...sig.map((s) => s.lastOrderAt?.getTime() ?? 0));
    if (last && Date.now() - last < SALE_SETTLE_MINUTES * 60_000) {
      return fail(e, "RECENT_SALE", `Venda há menos de ${SALE_SETTLE_MINUTES} min: aguarde a ADS refletir antes de aumentar`);
    }
    // Queda no ML desde a última leitura sem pedido registrado = venda ainda não processada pelo integrador.
    const cached = pool.rows.filter((r) => r.availableQuantity !== null);
    if (cached.length && e.marketplaceQuantity !== null) {
      const before = Math.max(...cached.map((r) => r.availableQuantity!));
      const since = Math.min(...cached.map((r) => new Date(r.lastSeenAt).getTime()));
      if (e.marketplaceQuantity < before && !(last && last >= since)) {
        return fail(e, "UNPROCESSED_SALE", `Estoque no ML caiu de ${before} para ${e.marketplaceQuantity} sem pedido registrado: aguarde o pedido ser processado`);
      }
    }
  }
  return { ...e, eligible: true };
}

// ---------------------------------------------------------------------------
// Simulação (DRY RUN) — consulta dados reais, grava propostas, nunca escreve no ML.
// ---------------------------------------------------------------------------

export interface ProposalView {
  id: string;
  runId: string;
  poolKey: string;
  marketplaceItemIds: string[];
  variationId: string | null;
  userProductId: string | null;
  productIds: number[];
  title: string | null;
  stockModel: string;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  adsQuantity: string | null;
  safetyReserve: number | null;
  pendingOrders: string | null;
  marketplaceQuantity: number | null;
  proposedQuantity: number | null;
  difference: number | null;
  direction: Direction | null;
  adsFetchedAt: Date | null;
  calculation: Record<string, unknown>;
  status: string;
  approvedBy: string | null;
  createdAt: Date;
}

const PROPOSAL_SELECT = `SELECT p.id::text AS id, p.run_id::text AS "runId", p.pool_key AS "poolKey", p.marketplace_item_ids AS "marketplaceItemIds",
  p.variation_id AS "variationId", p.user_product_id AS "userProductId", p.product_ids AS "productIds",
  (SELECT title FROM legacy_listings ll WHERE ll.marketplace_item_id = p.marketplace_item_ids[1] ORDER BY ll.removed_at NULLS FIRST LIMIT 1) AS title,
  p.stock_model AS "stockModel", p.eligible, p.reason_code AS "reasonCode", p.reason, trim_scale(p.ads_quantity)::text AS "adsQuantity",
  p.safety_reserve AS "safetyReserve", trim_scale(p.pending_orders)::text AS "pendingOrders", p.marketplace_quantity AS "marketplaceQuantity",
  p.proposed_quantity AS "proposedQuantity", p.difference, p.direction, p.ads_fetched_at AS "adsFetchedAt", p.calculation, p.status,
  p.approved_by AS "approvedBy", p.created_at AS "createdAt"
  FROM stock_sync_proposals p`;

async function insertProposal(sql: Sql, runId: string, e: Evaluation): Promise<string> {
  // Propostas anteriores ainda abertas para o mesmo estoque deixam de valer.
  await sql.execute(`UPDATE stock_sync_proposals SET status = 'SUPERSEDED' WHERE pool_key = $1::text AND status IN ('PROPOSED')`, [e.pool.key]);
  const status = e.eligible && e.direction && e.direction !== "NONE" ? "PROPOSED" : "SKIPPED";
  const [row] = await sql.query<{ id: string }>(
    `INSERT INTO stock_sync_proposals (run_id, pool_key, marketplace_item_ids, variation_id, user_product_id, product_ids, stock_model, eligible,
       reason_code, reason, ads_quantity, safety_reserve, pending_orders, marketplace_quantity, proposed_quantity, difference, direction,
       remote_version, ads_fetched_at, calculation, status)
     VALUES ($1::uuid, $2::text, $3::text[], $4::text, $5::text, $6::int[], $7::text, $8::boolean, $9::text, $10::text, $11::numeric, $12::int,
       $13::numeric, $14::int, $15::int, $16::int, $17::text, $18::text, $19::timestamptz, $20::jsonb, $21::text)
     RETURNING id::text AS id`,
    [
      runId,
      e.pool.key,
      e.pool.itemIds,
      e.pool.variationId || null,
      e.pool.userProductId,
      (e.pool.components ?? []).map((c) => c.productId),
      e.stockModel,
      e.eligible,
      e.reasonCode,
      e.reason,
      e.adsQuantity,
      e.safetyReserve,
      e.pendingOrders,
      e.marketplaceQuantity,
      e.proposedQuantity,
      e.difference,
      e.direction,
      e.state?.version ?? null,
      e.adsFetchedAt,
      JSON.stringify(e.calculation),
      status,
    ],
  );
  return row.id;
}

export interface PreviewOptions {
  requestedBy: string;
  mode?: "DRY_RUN" | "AUTO";
  /** Restringe aos estoques que contêm estes anúncios (MLB...). */
  itemIds?: string[];
  poolKeys?: string[];
  deadline?: number;
}

export interface PreviewResult {
  runId: string;
  status: "COMPLETED" | "PARTIAL";
  evaluated: number;
  pendingPools: number;
  summary: Record<string, number>;
  proposals: ProposalView[];
}

const timeLeft = (deadline?: number) => (deadline === undefined ? Infinity : deadline - Date.now());

export async function runPreview(sql: Sql, opts: PreviewOptions): Promise<PreviewResult> {
  const settings = await getStockSettings(sql);
  const all = await loadPools(sql);
  let selected = all.filter((p) => p.components || p.compositionError);
  if (opts.itemIds?.length) selected = selected.filter((p) => p.itemIds.some((id) => opts.itemIds!.includes(id)));
  if (opts.poolKeys) selected = selected.filter((p) => opts.poolKeys!.includes(p.key));
  const [{ id: runId }] = await sql.query<{ id: string }>(
    `INSERT INTO stock_sync_runs (mode, requested_by) VALUES ($1::text, $2::text) RETURNING id::text AS id`,
    [opts.mode ?? "DRY_RUN", opts.requestedBy],
  );
  const summary: Record<string, number> = { eligible: 0, increase: 0, decrease: 0, inSync: 0, ineligible: 0 };
  let evaluated = 0;
  try {
    const ctx = await buildContext(sql, selected, all, settings, { deadline: opts.deadline, auto: opts.mode === "AUTO" });
    for (const pool of selected) {
      if (timeLeft(opts.deadline) < 5_000) break;
      const e = await evaluatePool(pool, ctx);
      await insertProposal(sql, runId, e);
      evaluated++;
      if (!e.eligible) {
        summary.ineligible++;
        summary[`reason:${e.reasonCode}`] = (summary[`reason:${e.reasonCode}`] ?? 0) + 1;
      } else {
        summary.eligible++;
        if (e.direction === "INCREASE") summary.increase++;
        else if (e.direction === "DECREASE") summary.decrease++;
        else summary.inSync++;
      }
    }
  } catch (err) {
    const c = classifyError(err);
    await sql.execute(`UPDATE stock_sync_runs SET status = 'FAILED', finished_at = now(), error_message = $2::text, summary = $3::jsonb WHERE id = $1::uuid`, [runId, c.message, JSON.stringify(summary)]);
    throw err;
  }
  const status = evaluated < selected.length ? "PARTIAL" : "COMPLETED";
  await sql.execute(`UPDATE stock_sync_runs SET status = $2::text, finished_at = now(), summary = $3::jsonb WHERE id = $1::uuid`, [
    runId,
    status,
    JSON.stringify({ ...summary, evaluated, pools: selected.length, ...(opts.itemIds?.length || opts.poolKeys ? { scope: "ITEMS" } : {}) }),
  ]);
  const proposals = await sql.query<ProposalView>(`${PROPOSAL_SELECT} WHERE p.run_id = $1::uuid ORDER BY p.eligible DESC, abs(COALESCE(p.difference, 0)) DESC, p.id`, [runId]);
  return { runId, status, evaluated, pendingPools: selected.length - evaluated, summary, proposals };
}

export async function getRunProposals(sql: Sql, runId: string): Promise<ProposalView[]> {
  return sql.query<ProposalView>(`${PROPOSAL_SELECT} WHERE p.run_id = $1::uuid ORDER BY p.eligible DESC, abs(COALESCE(p.difference, 0)) DESC, p.id`, [runId]);
}

export async function latestRun(sql: Sql, mode: "DRY_RUN" | "AUTO" = "DRY_RUN") {
  const [run] = await sql.query<{ id: string; status: string; requestedBy: string; startedAt: Date; finishedAt: Date | null; summary: unknown }>(
    `SELECT id::text AS id, status, requested_by AS "requestedBy", started_at AS "startedAt", finished_at AS "finishedAt", summary
     FROM stock_sync_runs WHERE mode = $1::text AND (summary IS NULL OR summary->>'scope' IS DISTINCT FROM 'ITEMS')
     ORDER BY started_at DESC LIMIT 1`,
    [mode],
  );
  return run ?? null;
}

// ---------------------------------------------------------------------------
// Validação (reconsulta ADS e ML) e token de confirmação explícita.
// ---------------------------------------------------------------------------

/** Proposta mais antiga que isto precisa ser simulada de novo. */
export const PROPOSAL_TTL_MINUTES = 30;
const TOKEN_TTL_MS = 10 * 60_000;

export interface ValidationItem {
  proposalId: string;
  poolKey: string;
  itemIds: string[];
  title: string | null;
  stockModel: string;
  marketplaceQuantity: number | null;
  proposedQuantity: number | null;
  freshMarketplaceQuantity: number | null;
  freshProposedQuantity: number | null;
  direction: Direction | null;
  ok: boolean;
  reason: string | null;
}

function sign(payload: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(`stock-sync:v1:${payload}`).digest("base64url");
}

export function makeConfirmationToken(items: { proposalId: string; target: number }[], expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ i: items.map((x) => [x.proposalId, x.target]).sort(), e: expiresAt })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readConfirmationToken(token: string): { items: Map<string, number>; expiresAt: number } | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { i: [string, number][]; e: number };
    return { items: new Map(data.i), expiresAt: data.e };
  } catch {
    return null;
  }
}

async function loadOpenProposals(sql: Sql, ids: string[]) {
  return sql.query<{ id: string; poolKey: string; status: string; mode: string; eligible: boolean; proposedQuantity: number | null; marketplaceQuantity: number | null; direction: Direction | null; createdAt: Date; title: string | null; itemIds: string[]; stockModel: string }>(
    `SELECT p.id::text AS id, p.pool_key AS "poolKey", p.status, r.mode, p.eligible, p.proposed_quantity AS "proposedQuantity",
            p.marketplace_quantity AS "marketplaceQuantity", p.direction, p.created_at AS "createdAt", p.marketplace_item_ids AS "itemIds",
            p.stock_model AS "stockModel",
            (SELECT title FROM legacy_listings ll WHERE ll.marketplace_item_id = p.marketplace_item_ids[1] LIMIT 1) AS title
     FROM stock_sync_proposals p JOIN stock_sync_runs r ON r.id = p.run_id WHERE p.id = ANY($1::bigint[])`,
    [ids],
  );
}

export async function validateProposals(
  sql: Sql,
  proposalIds: string[],
): Promise<{ items: ValidationItem[]; blockers: string[]; confirmationToken: string | null; expiresAt: string | null; settings: { stockSourceConfirmed: boolean; maxJobsPerRun: number } }> {
  const settings = await getStockSettings(sql);
  const props = await loadOpenProposals(sql, proposalIds);
  const items: ValidationItem[] = [];
  const all = await loadPools(sql);
  const toCheck: { prop: (typeof props)[number]; pool: Pool }[] = [];
  for (const id of proposalIds) {
    const p = props.find((x) => x.id === id);
    const base = {
      proposalId: id,
      poolKey: p?.poolKey ?? "",
      itemIds: p?.itemIds ?? [],
      title: p?.title ?? null,
      stockModel: p?.stockModel ?? "UNKNOWN",
      marketplaceQuantity: p?.marketplaceQuantity ?? null,
      proposedQuantity: p?.proposedQuantity ?? null,
      freshMarketplaceQuantity: null,
      freshProposedQuantity: null,
      direction: p?.direction ?? null,
    };
    const bad = (reason: string) => items.push({ ...base, ok: false, reason });
    if (!p) bad("Proposta não encontrada");
    else if (p.mode !== "DRY_RUN") bad("Somente propostas de simulação manual podem ser aprovadas aqui");
    else if (p.status !== "PROPOSED") bad(`Proposta em situação ${p.status}: simule novamente`);
    else if (!p.eligible || p.proposedQuantity === null) bad("Proposta não elegível");
    else if (Date.now() - new Date(p.createdAt).getTime() > PROPOSAL_TTL_MINUTES * 60_000) bad(`Proposta com mais de ${PROPOSAL_TTL_MINUTES} min: simule novamente`);
    else {
      const pool = all.find((x) => x.key === p.poolKey);
      if (!pool) bad("Anúncio não está mais no inventário ou perdeu o vínculo");
      else toCheck.push({ prop: p, pool });
    }
  }
  if (toCheck.length) {
    const active = new Set(
      (
        // Uma atualização automática ainda na fila não bloqueia: a aprovação manual a substitui (ver applyProposals).
        await sql.query<{ poolKey: string }>(
          `SELECT pool_key AS "poolKey" FROM stock_sync_jobs
           WHERE (status = 'RUNNING' OR (status = 'QUEUED' AND sync_mode = 'MANUAL')) AND pool_key = ANY($1::text[])`,
          [
          toCheck.map((t) => t.pool.key),
        ])
      ).map((r) => r.poolKey),
    );
    const ctx = await buildContext(
      sql,
      toCheck.map((t) => t.pool),
      all,
      settings,
    );
    for (const { prop, pool } of toCheck) {
      const base = {
        proposalId: prop.id,
        poolKey: prop.poolKey,
        itemIds: prop.itemIds,
        title: prop.title,
        stockModel: prop.stockModel,
        marketplaceQuantity: prop.marketplaceQuantity,
        proposedQuantity: prop.proposedQuantity,
        direction: prop.direction,
      };
      if (active.has(pool.key)) {
        items.push({ ...base, freshMarketplaceQuantity: null, freshProposedQuantity: null, ok: false, reason: "Já existe uma atualização em andamento para este estoque" });
        continue;
      }
      const e = await evaluatePool(pool, ctx);
      const fresh = { freshMarketplaceQuantity: e.marketplaceQuantity, freshProposedQuantity: e.proposedQuantity };
      let reason: string | null = null;
      if (!e.eligible) reason = e.reason ?? "Não elegível";
      else if (e.proposedQuantity !== prop.proposedQuantity) reason = `A quantidade calculada mudou (${prop.proposedQuantity} → ${e.proposedQuantity}): simule novamente`;
      else if (e.direction === "NONE") reason = "O Mercado Livre já está com a quantidade proposta";
      if (reason) {
        // Proposta desatualizada não pode mais ser aprovada.
        await sql.execute(`UPDATE stock_sync_proposals SET status = 'STALE' WHERE id = $1::bigint AND status = 'PROPOSED'`, [prop.id]);
      }
      items.push({ ...base, ...fresh, direction: e.direction, ok: !reason, reason });
    }
  }
  // Mantém a ordem pedida.
  items.sort((a, b) => proposalIds.indexOf(a.proposalId) - proposalIds.indexOf(b.proposalId));
  const ok = items.filter((i) => i.ok);
  const blockers: string[] = [];
  if (!settings.stockSourceConfirmed) blockers.push("Confirme nas configurações que o saldo da ADS corresponde ao estoque vendável (reservas e movimentações incluídas).");
  if (ok.length > settings.maxJobsPerRun) blockers.push(`Selecione no máximo ${settings.maxJobsPerRun} atualizações por vez.`);
  if (!ok.length) blockers.push("Nenhuma proposta válida para aplicar.");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const confirmationToken = blockers.length ? null : makeConfirmationToken(ok.map((i) => ({ proposalId: i.proposalId, target: i.proposedQuantity! })), expiresAt);
  return {
    items,
    blockers,
    confirmationToken,
    expiresAt: confirmationToken ? new Date(expiresAt).toISOString() : null,
    settings: { stockSourceConfirmed: settings.stockSourceConfirmed, maxJobsPerRun: settings.maxJobsPerRun },
  };
}

// ---------------------------------------------------------------------------
// Aplicação: jobs persistentes, reavaliação imediatamente antes da escrita, verificação remota.
// ---------------------------------------------------------------------------

export interface JobView {
  id: string;
  proposalId: string | null;
  poolKey: string;
  syncMode: string;
  status: string;
  authorizedBy: string;
  stockModel: string | null;
  targetQuantity: number;
  beforeQuantity: number | null;
  appliedQuantity: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  title: string | null;
  itemIds: string[] | null;
}

const JOB_SELECT = `SELECT j.id::text AS id, j.proposal_id::text AS "proposalId", j.pool_key AS "poolKey", j.sync_mode AS "syncMode", j.status,
  j.authorized_by AS "authorizedBy", j.stock_model AS "stockModel", j.target_quantity AS "targetQuantity", j.before_quantity AS "beforeQuantity",
  j.applied_quantity AS "appliedQuantity", j.status_before AS "statusBefore", j.status_after AS "statusAfter", j.attempts,
  j.error_code AS "errorCode", j.error_message AS "errorMessage", j.created_at AS "createdAt", j.completed_at AS "completedAt",
  p.marketplace_item_ids AS "itemIds",
  (SELECT title FROM legacy_listings ll WHERE ll.marketplace_item_id = p.marketplace_item_ids[1] LIMIT 1) AS title
  FROM stock_sync_jobs j LEFT JOIN stock_sync_proposals p ON p.id = j.proposal_id`;

export async function listJobs(sql: Sql, opts: { ids?: string[]; limit?: number; status?: string } = {}): Promise<JobView[]> {
  return sql.query<JobView>(
    `${JOB_SELECT} WHERE ($1::uuid[] IS NULL OR j.id = ANY($1::uuid[])) AND ($2::text IS NULL OR j.status = $2::text)
     ORDER BY j.created_at DESC LIMIT $3::int`,
    [opts.ids ?? null, opts.status ?? null, Math.min(Math.max(opts.limit ?? 100, 1), 500)],
  );
}

export async function applyProposals(
  sql: Sql,
  input: { proposalIds: string[]; confirmationToken: string; actor: string; deadline?: number },
): Promise<{ jobs: JobView[]; skipped: { proposalId: string; reason: string }[] }> {
  const token = readConfirmationToken(input.confirmationToken);
  if (!token) throw new StockSyncError("invalid_confirmation", "Confirmação inválida: valide as propostas novamente", 422);
  if (token.expiresAt < Date.now()) throw new StockSyncError("confirmation_expired", "Confirmação expirada: valide as propostas novamente", 422);
  const ids = [...new Set(input.proposalIds)];
  if (ids.length !== token.items.size || ids.some((id) => !token.items.has(id))) {
    throw new StockSyncError("confirmation_mismatch", "A seleção difere da que foi validada: valide novamente", 422);
  }
  const settings = await getStockSettings(sql);
  if (!settings.stockSourceConfirmed) throw new StockSyncError("stock_source_unconfirmed", "Confirme nas configurações que o saldo da ADS é o estoque vendável");
  if (ids.length > settings.maxJobsPerRun) throw new StockSyncError("too_many", `No máximo ${settings.maxJobsPerRun} atualizações por vez`, 422);

  const jobIds: string[] = [];
  const skipped: { proposalId: string; reason: string }[] = [];
  for (const id of ids) {
    const idem = `manual:${id}`;
    const [existing] = await sql.query<{ id: string }>(`SELECT id::text AS id FROM stock_sync_jobs WHERE idempotency_key = $1::text`, [idem]);
    if (existing) {
      // Repetição da mesma confirmação: devolve o job já criado (idempotência).
      jobIds.push(existing.id);
      continue;
    }
    const target = token.items.get(id)!;
    const [prop] = await sql.query<{ poolKey: string; stockModel: string }>(
      `UPDATE stock_sync_proposals SET status = 'APPROVED', approved_by = $2::text, approved_at = now()
       WHERE id = $1::bigint AND status = 'PROPOSED' AND eligible AND proposed_quantity = $3::int
       RETURNING pool_key AS "poolKey", stock_model AS "stockModel"`,
      [id, input.actor, target],
    );
    if (!prop) {
      skipped.push({ proposalId: id, reason: "Proposta não está mais aberta ou mudou" });
      continue;
    }
    // A aprovação manual (com ADS e ML recém-consultados) substitui uma atualização automática que ainda espera na fila.
    const superseded = await sql.query<{ id: string; proposalId: string | null }>(
      `UPDATE stock_sync_jobs SET status = 'SKIPPED', error_code = 'SUPERSEDED_BY_MANUAL', error_message = 'Substituída pela aprovação manual',
         completed_at = now(), locked_until = NULL, updated_at = now()
       WHERE pool_key = $1::text AND status = 'QUEUED' AND sync_mode = 'AUTO'
       RETURNING id::text AS id, proposal_id::text AS "proposalId"`,
      [prop.poolKey],
    );
    for (const s of superseded) {
      if (s.proposalId) await sql.execute(`UPDATE stock_sync_proposals SET status = 'SUPERSEDED' WHERE id = $1::bigint`, [s.proposalId]);
      await recordHistory(sql, { type: "sync_superseded", actor: input.actor, jobId: s.id, details: { poolKey: prop.poolKey, byProposalId: id } });
    }
    try {
      const [job] = await sql.query<{ id: string }>(
        `INSERT INTO stock_sync_jobs (proposal_id, pool_key, sync_mode, authorized_by, idempotency_key, stock_model, target_quantity)
         VALUES ($1::bigint, $2::text, 'MANUAL', $3::text, $4::text, $5::text, $6::int) RETURNING id::text AS id`,
        [id, prop.poolKey, input.actor, idem, prop.stockModel, target],
      );
      jobIds.push(job.id);
      await recordHistory(sql, { type: "sync_authorized", actor: input.actor, jobId: job.id, details: { proposalId: id, poolKey: prop.poolKey, target } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await sql.execute(`UPDATE stock_sync_proposals SET status = 'PROPOSED', approved_by = NULL, approved_at = NULL WHERE id = $1::bigint`, [id]);
      skipped.push({ proposalId: id, reason: "Já existe uma atualização em andamento para este estoque" });
    }
  }
  if (jobIds.length) await processStockJobs(sql, { jobIds, deadline: input.deadline });
  return { jobs: jobIds.length ? await listJobs(sql, { ids: jobIds }) : [], skipped };
}

interface ClaimedJob {
  id: string;
  proposalId: string | null;
  poolKey: string;
  syncMode: string;
  authorizedBy: string;
  targetQuantity: number;
  attempts: number;
  maxAttempts: number;
}

async function logAttempt(sql: Sql, jobId: string, a: { operation: string; request?: unknown; response?: unknown; httpStatus?: number | null; errorCode?: string | null; errorMessage?: string | null; durationMs?: number | null }) {
  await sql.execute(
    `INSERT INTO stock_sync_attempts (job_id, operation, request, response, http_status, error_code, error_message, duration_ms)
     VALUES ($1::uuid, $2::text, $3::jsonb, $4::jsonb, $5::int, $6::text, $7::text, $8::int)`,
    [
      jobId,
      a.operation,
      a.request === undefined ? null : JSON.stringify(sanitize(a.request)),
      a.response === undefined ? null : JSON.stringify(sanitize(a.response)),
      a.httpStatus ?? null,
      a.errorCode ?? null,
      a.errorMessage ?? null,
      a.durationMs ?? null,
    ],
  );
}

const PROPOSAL_STATUS: Record<string, string> = { SUCCEEDED: "APPLIED", DIVERGED: "DIVERGED", FAILED: "FAILED", STALE: "STALE", SKIPPED: "SKIPPED" };

async function finishJob(
  sql: Sql,
  job: ClaimedJob,
  r: { status: "SUCCEEDED" | "DIVERGED" | "FAILED" | "STALE" | "SKIPPED"; model?: StockModel | null; before?: number | null; applied?: number | null; statusBefore?: string | null; statusAfter?: string | null; code?: string | null; message?: string | null },
) {
  await sql.execute(
    `UPDATE stock_sync_jobs SET status = $2::text, stock_model = COALESCE($3::text, stock_model), before_quantity = COALESCE($4::int, before_quantity),
       applied_quantity = $5::int, status_before = COALESCE($6::text, status_before), status_after = $7::text, error_code = $8::text,
       error_message = $9::text, completed_at = now(), locked_until = NULL, updated_at = now()
     WHERE id = $1::uuid`,
    [job.id, r.status, r.model ?? null, r.before ?? null, r.applied ?? null, r.statusBefore ?? null, r.statusAfter ?? null, r.code ?? null, r.message ?? null],
  );
  if (job.proposalId) await sql.execute(`UPDATE stock_sync_proposals SET status = $2::text WHERE id = $1::bigint`, [job.proposalId, PROPOSAL_STATUS[r.status]]);
  await recordHistory(sql, {
    type: `sync_${r.status.toLowerCase()}`,
    actor: job.authorizedBy,
    jobId: job.id,
    details: { poolKey: job.poolKey, target: job.targetQuantity, before: r.before ?? null, applied: r.applied ?? null, code: r.code ?? null, message: r.message ?? null },
  });
  if (r.status === "DIVERGED" || r.status === "FAILED") {
    await raiseAlert(sql, `stock_sync_${r.status.toLowerCase()}:${job.poolKey}`, `Atualização de estoque ${r.status === "DIVERGED" ? "não refletida" : "falhou"} (${job.poolKey}): ${r.message ?? r.code ?? ""}`, {
      jobId: job.id,
    });
  }
}

async function requeue(sql: Sql, job: ClaimedJob, code: string, message: string, retryAfterMs?: number, opts: { free?: boolean } = {}): Promise<boolean> {
  // free: adiado por falta de tempo no ciclo (nada foi enviado) — não gasta tentativa.
  if (!opts.free && job.attempts >= job.maxAttempts) return false;
  const wait = opts.free ? (retryAfterMs ?? 0) : backoffMs(job.attempts, retryAfterMs);
  await sql.execute(
    `UPDATE stock_sync_jobs SET status = 'QUEUED', next_run_at = now() + make_interval(secs => $2::int), locked_until = NULL, error_code = $3::text,
       error_message = $4::text, attempts = GREATEST(attempts - $5::int, 0), updated_at = now() WHERE id = $1::uuid`,
    [job.id, Math.ceil(wait / 1000), code, message, opts.free ? 1 : 0],
  );
  return true;
}

const statusText = (s: RemoteState | null) => (s ? s.items.map((i) => `${i.itemId}:${i.status}${i.subStatus.length ? `(${i.subStatus.join("/")})` : ""}`).join(", ").slice(0, 500) : null);

/** Lê de novo até a quantidade aparecer (o ML pode levar alguns instantes para refletir a escrita). */
async function verify(pool: Pool, target: number): Promise<RemoteState> {
  let state = await readRemoteState(pool);
  for (let i = 0; i < 2 && state.quantity !== target; i++) {
    await retrySleep(1_500);
    state = await readRemoteState(pool);
  }
  return state;
}

/** Atualiza a cópia local depois da escrita verificada (inventário e anúncios publicados pelo integrador). */
async function updateLocal(sql: Sql, pool: Pool, state: RemoteState, applied: number | null) {
  for (const it of state.items) {
    const qty = pool.variationId ? it.variationQuantity : it.availableQuantity;
    await sql.execute(
      `UPDATE legacy_listings SET status = COALESCE($3::text, status), sub_status = $4::jsonb, available_quantity = COALESCE($5::int, available_quantity), last_seen_at = now()
       WHERE marketplace_item_id = $1::text AND variation_id = $2::text`,
      [it.itemId, pool.variationId, it.found ? it.status : null, JSON.stringify(it.subStatus), qty],
    );
    if (applied !== null) {
      // O valor publicado passa a ser o aplicado: evita uma falsa divergência de quantidade no monitoramento.
      await sql.execute(
        `UPDATE marketplace_listings SET quantity = $2::int, remote_quantity = COALESCE($3::int, remote_quantity), updated_at = now()
         WHERE marketplace_item_id = $1::text AND status <> 'deleted'`,
        [it.itemId, applied, it.availableQuantity],
      );
    }
  }
}

async function runJob(sql: Sql, job: ClaimedJob, deadline?: number): Promise<void> {
  const settings = await getStockSettings(sql);
  const all = await loadPools(sql);
  const pool = all.find((p) => p.key === job.poolKey);
  if (!pool) return finishJob(sql, job, { status: "STALE", code: "POOL_NOT_FOUND", message: "Anúncio fora do inventário ou sem vínculo" });
  for (let round = 0; round < 2; round++) {
    // Reconsulta ADS e ML imediatamente antes da escrita.
    const ctx = await buildContext(sql, [pool], all, settings, { deadline });
    const e = await evaluatePool(pool, ctx);
    await logAttempt(sql, job.id, {
      operation: "EVALUATE",
      response: { eligible: e.eligible, reasonCode: e.reasonCode, model: e.stockModel, marketplaceQuantity: e.marketplaceQuantity, proposedQuantity: e.proposedQuantity, version: e.state?.version ?? null },
    });
    if (!e.eligible) return finishJob(sql, job, { status: "STALE", model: e.stockModel, before: e.marketplaceQuantity, code: e.reasonCode, message: e.reason });
    if (e.proposedQuantity !== job.targetQuantity) {
      return finishJob(sql, job, {
        status: "STALE",
        model: e.stockModel,
        before: e.marketplaceQuantity,
        code: "PROPOSAL_CHANGED",
        message: `A quantidade calculada mudou (${job.targetQuantity} → ${e.proposedQuantity}); nada foi enviado`,
      });
    }
    const state = e.state!;
    const before = state.quantity;
    if (before === job.targetQuantity) {
      await updateLocal(sql, pool, state, job.targetQuantity);
      return finishJob(sql, job, { status: "SUCCEEDED", model: state.model, before, applied: before, statusBefore: statusText(state), statusAfter: statusText(state), code: "ALREADY_IN_SYNC" });
    }
    if (timeLeft(deadline) < 6_000) {
      await requeue(sql, job, "DEADLINE", "Sem tempo nesta execução; continua no próximo ciclo", 30_000, { free: true });
      return;
    }
    const call = buildWrite(pool, state, job.targetQuantity);
    let wrote = false;
    try {
      const res = await executeWrite(call);
      wrote = true;
      await logAttempt(sql, job.id, { operation: call.operation, request: { path: call.path, body: call.body, headers: call.headers }, response: res.response, httpStatus: res.status, durationMs: res.durationMs });
    } catch (err) {
      const c = classifyError(err);
      await logAttempt(sql, job.id, { operation: call.operation, request: { path: call.path, body: call.body, headers: call.headers }, httpStatus: c.httpStatus, errorCode: c.code, errorMessage: c.message, response: err instanceof MeliHttpError ? err.body : undefined });
      if (err instanceof MeliHttpError && err.status === 409 && round === 0) continue; // x-version desatualizado: reconsulta e reavalia
      if (!(c.retryable || c.auth)) {
        return finishJob(sql, job, { status: "FAILED", model: state.model, before, statusBefore: statusText(state), code: c.code, message: c.message });
      }
      // Resultado incerto (timeout, 5xx...): a escrita é absoluta e idempotente; confere antes de repetir.
      try {
        const check = await readRemoteState(pool);
        if (check.quantity === job.targetQuantity) {
          await updateLocal(sql, pool, check, job.targetQuantity);
          return finishJob(sql, job, { status: "SUCCEEDED", model: state.model, before, applied: check.quantity, statusBefore: statusText(state), statusAfter: statusText(check) });
        }
      } catch {
        /* sem leitura: tenta de novo mais tarde */
      }
      if (await requeue(sql, job, c.code, c.message, c.retryAfterMs)) return;
      return finishJob(sql, job, { status: "FAILED", model: state.model, before, statusBefore: statusText(state), code: c.code, message: `Tentativas esgotadas: ${c.message}` });
    }
    if (wrote) {
      const after = await verify(pool, job.targetQuantity);
      await logAttempt(sql, job.id, { operation: "VERIFY", response: { quantity: after.quantity, model: after.model, items: after.items.map((i) => ({ itemId: i.itemId, status: i.status, subStatus: i.subStatus })) } });
      await updateLocal(sql, pool, after, after.quantity === job.targetQuantity ? job.targetQuantity : null);
      const statusBefore = statusText(state);
      const statusAfter = statusText(after);
      if (statusBefore !== statusAfter) {
        // Ex.: quantidade zero → o ML pausa por falta de estoque; positiva → reativa o pausado por falta de estoque.
        await recordHistory(sql, { type: "listing_status_changed_by_quantity", actor: job.authorizedBy, jobId: job.id, details: { before: statusBefore, after: statusAfter, target: job.targetQuantity } });
      }
      if (after.quantity === job.targetQuantity) {
        return finishJob(sql, job, { status: "SUCCEEDED", model: state.model, before, applied: after.quantity, statusBefore, statusAfter });
      }
      return finishJob(sql, job, {
        status: "DIVERGED",
        model: state.model,
        before,
        applied: after.quantity,
        statusBefore,
        statusAfter,
        code: "NOT_REFLECTED",
        message: `O Mercado Livre respondeu sucesso, mas a quantidade lida depois é ${after.quantity ?? "desconhecida"} (esperado ${job.targetQuantity})`,
      });
    }
  }
  return finishJob(sql, job, { status: "FAILED", code: "VERSION_CONFLICT", message: "Conflito de versão (x-version) persistente: simule novamente" });
}

/** Processa jobs pendentes (os indicados ou os vencidos), um por vez, dentro do prazo. */
export async function processStockJobs(sql: Sql, opts: { jobIds?: string[]; deadline?: number } = {}): Promise<number> {
  await sql.execute(`UPDATE stock_sync_jobs SET status = 'QUEUED', locked_until = NULL, updated_at = now() WHERE status = 'RUNNING' AND locked_until < now()`);
  let processed = 0;
  for (let guard = 0; guard < 500; guard++) {
    if (timeLeft(opts.deadline) < 8_000) break;
    const [job] = await sql.query<ClaimedJob>(
      `UPDATE stock_sync_jobs SET status = 'RUNNING', attempts = attempts + 1, started_at = COALESCE(started_at, now()),
         locked_until = now() + interval '2 minutes', updated_at = now()
       WHERE id = (SELECT id FROM stock_sync_jobs WHERE status = 'QUEUED' AND next_run_at <= now() AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id::text AS id, proposal_id::text AS "proposalId", pool_key AS "poolKey", sync_mode AS "syncMode", authorized_by AS "authorizedBy",
                 target_quantity AS "targetQuantity", attempts, max_attempts AS "maxAttempts"`,
      [opts.jobIds ?? null],
    );
    if (!job) break;
    processed++;
    try {
      await runJob(sql, job, opts.deadline);
    } catch (err) {
      const c = classifyError(err);
      logger.error("Falha ao processar job de estoque", { jobId: job.id, code: c.code });
      await logAttempt(sql, job.id, { operation: "ERROR", errorCode: c.code, errorMessage: c.message }).catch(() => undefined);
      if (!(await requeue(sql, job, c.code, c.message, c.retryAfterMs))) {
        await finishJob(sql, job, { status: "FAILED", code: c.code, message: c.message });
      }
      if (err instanceof MeliAuthError || c.auth) break;
    }
  }
  return processed;
}

// ---------------------------------------------------------------------------
// Automação (preparada e DESLIGADA por padrão).
// ---------------------------------------------------------------------------

export interface AutoResult {
  ran: boolean;
  reason: string | null;
  runId?: string;
  jobs?: number;
}

/** Estoques conferidos por tick da automação (o tick tem ~45 s e o ML pode exigir leitura anúncio a anúncio). */
const AUTO_POOLS_PER_TICK = 60;
/** Tempo mínimo para começar uma atualização automática (reler ADS e ML, gravar e conferir). */
const AUTO_JOB_MIN_LEFT_MS = 12_000;

export async function runAutoStockSync(sql: Sql, opts: { deadline?: number; force?: boolean } = {}): Promise<AutoResult> {
  const settings = await getStockSettings(sql);
  const state = autoSyncState(settings);
  if (!state.active) return { ran: false, reason: state.reason };
  // Fora do expediente da ADS (servidores desligados) nem tenta.
  const hours = adsHoursState(settings);
  if (!hours.open) return { ran: false, reason: hours.reason };
  const owner = randomUUID();
  if (!(await acquireLease(sql, owner, "stock-auto-sync"))) return { ran: false, reason: "Outra execução em andamento" };
  try {
    let pools = (await loadPools(sql)).filter((p) => p.components && !p.compositionError);
    if (settings.autoSyncScope === "APPROVED_GROUPS") {
      const approved = new Set(
        (await sql.query<{ productId: number }>(`SELECT product_id AS "productId" FROM stock_sync_groups WHERE auto_sync_approved`)).map((r) => r.productId),
      );
      if (!approved.size) return { ran: false, reason: "Nenhum grupo de estoque aprovado para automação" };
      pools = pools.filter((p) => p.components!.every((c) => approved.has(c.productId)));
    }
    if (!pools.length) return { ran: false, reason: "Nenhum anúncio vinculado para automatizar" };
    // ADS fora do ar há pouco (nesta instância): nem consulta; o próximo tick tenta de novo.
    const down = adsUnavailable();
    if (down) return { ran: false, reason: down };
    // Rodízio: cada estoque é conferido no máximo uma vez por intervalo; o que não couber num tick fica para o próximo.
    // Não contam como conferidos: falha ao ler a ADS (fora do ar/sem tempo) e propostas que ficaram sem atualização
    // (acima do limite por execução) — esses voltam no próximo tick.
    if (!opts.force) {
      const recent = new Set(
        (
          await sql.query<{ poolKey: string }>(
            `SELECT DISTINCT p.pool_key AS "poolKey" FROM stock_sync_proposals p JOIN stock_sync_runs r ON r.id = p.run_id
             WHERE r.mode = 'AUTO' AND p.created_at > now() - make_interval(mins => $1::int)
               AND COALESCE(p.reason_code, '') <> 'ADS_ERROR' AND p.status NOT IN ('PROPOSED', 'SUPERSEDED')`,
            [settings.autoSyncIntervalMin],
          )
        ).map((r) => r.poolKey),
      );
      pools = pools.filter((p) => !recent.has(p.key));
      if (!pools.length) return { ran: false, reason: "Todos os estoques já conferidos neste intervalo" };
    }
    pools = pools.slice(0, AUTO_POOLS_PER_TICK);
    const preview = await runPreview(sql, { requestedBy: "system:auto", mode: "AUTO", poolKeys: pools.map((p) => p.key), deadline: opts.deadline });
    const eligible = preview.proposals.filter((p) => p.status === "PROPOSED").slice(0, settings.maxJobsPerRun);
    const jobIds: string[] = [];
    // Cria e grava uma atualização por vez, só enquanto houver tempo no ciclo. As que não couberem continuam PROPOSED
    // e voltam no próximo tick com ADS e ML relidos — sem formar fila de jobs com quantidade antiga que travaria o anúncio.
    for (const p of eligible) {
      if (timeLeft(opts.deadline) < AUTO_JOB_MIN_LEFT_MS) break;
      await sql.execute(`UPDATE stock_sync_proposals SET status = 'APPROVED', approved_by = 'system:auto', approved_at = now() WHERE id = $1::bigint AND status = 'PROPOSED'`, [p.id]);
      try {
        const [job] = await sql.query<{ id: string }>(
          `INSERT INTO stock_sync_jobs (proposal_id, pool_key, sync_mode, authorized_by, idempotency_key, stock_model, target_quantity)
           VALUES ($1::bigint, $2::text, 'AUTO', 'system:auto', $3::text, $4::text, $5::int) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
          [p.id, p.poolKey, `auto:${p.id}`, p.stockModel, p.proposedQuantity],
        );
        if (job) {
          jobIds.push(job.id);
          await processStockJobs(sql, { jobIds: [job.id], deadline: opts.deadline });
        }
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await sql.execute(`UPDATE stock_sync_proposals SET status = 'SKIPPED', reason = 'Atualização já em andamento' WHERE id = $1::bigint`, [p.id]);
      }
    }
    return { ran: true, reason: null, runId: preview.runId, jobs: jobIds.length };
  } finally {
    await releaseLease(sql, owner, "stock-auto-sync").catch(() => undefined);
  }
}

/** Chamado pelo tick do agendador: retentativas de jobs já autorizados e automação (se ativa e vencida). */
export async function runStockSyncTick(sql: Sql, deadline: number): Promise<{ processed: number; auto: AutoResult }> {
  let processed = 0;
  // Fora do expediente da ADS as retentativas também esperam (cada uma reconsulta a ADS antes de gravar).
  const settings = await getStockSettings(sql);
  const hours = adsHoursState(settings);
  if (!hours.open) return { processed, auto: { ran: false, reason: hours.reason } };
  // Atualização automática que nunca chegou a rodar e já passou do intervalo: a quantidade dela é velha. Descarta;
  // o rodízio confere o estoque de novo com ADS e ML atuais.
  const expired = await sql.query<{ proposalId: string | null }>(
    `UPDATE stock_sync_jobs SET status = 'STALE', error_code = 'EXPIRED', error_message = 'Ficou na fila além do intervalo da automação; será conferido de novo',
       completed_at = now(), locked_until = NULL, updated_at = now()
     WHERE status = 'QUEUED' AND sync_mode = 'AUTO' AND started_at IS NULL AND created_at < now() - make_interval(mins => $1::int)
     RETURNING proposal_id::text AS "proposalId"`,
    [settings.autoSyncIntervalMin],
  );
  const expiredProposals = expired.map((e) => e.proposalId).filter((x): x is string => !!x);
  if (expiredProposals.length) await sql.execute(`UPDATE stock_sync_proposals SET status = 'STALE' WHERE id = ANY($1::bigint[])`, [expiredProposals]);
  const [{ due }] = await sql.query<{ due: number }>(`SELECT count(*)::int AS due FROM stock_sync_jobs WHERE status IN ('QUEUED', 'RUNNING')`);
  if (due > 0) processed = await processStockJobs(sql, { deadline });
  // Várias rodadas enquanto houver tempo: cada uma confere um lote do rodízio; para quando todos foram conferidos
  // no intervalo, quando a ADS cai ou quando o tempo acaba.
  let auto: AutoResult = { ran: false, reason: "Sem tempo neste ciclo" };
  for (let round = 0; round < 8 && timeLeft(deadline) > 15_000; round++) {
    const r = await runAutoStockSync(sql, { deadline });
    if (round === 0 || r.ran) auto = r;
    if (!r.ran) break;
  }
  return { processed, auto };
}
