import "server-only";
import { randomUUID } from "node:crypto";
import { AdsNoTimeError, getAllPagesForIds, isAdsOutage } from "../ads/client";
import { adsHoursState } from "../ads/hours";
import { mapStocks } from "../ads/schemas";
import { acquireLease, releaseLease } from "../imports/jobs";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { pendingConsumption } from "../stock/reconcile";
import { getStockSettings } from "../stock/settings";
import { MercadoLivreInventoryAdapter } from "./adapters/mercadolivre";
import { NuvemshopInventoryAdapter, nsExposure } from "./adapters/nuvemshop";
import type { ChannelListingInventory } from "./adapters/types";
import { distributeWithinChannel, planQuotas, type ChannelExposure, type QuotaPlan } from "./allocation";
import { ensurePool, ensureSkus, lockPoolRow, type SkuRecord } from "./identity";
import { ingestMercadoLivreOrders, type IngestResult } from "./ingest";
import { drainOutbox, enqueueOutbox, recordMovement, withPoolLock } from "./ledger";
import { assertInventoryEnabled, InventoryError } from "./mode";
import { computePosition, type Position, type SnapshotInput } from "./position";
import { discoverLocations, effectivePolicies, getInventorySettings, type InventorySettings, type LocationRow, type StoredPolicy } from "./settings";

/**
 * Reconciliação em MODO SOMBRA.
 *
 * Lê: inventário de anúncios e vínculos (banco local, alimentado pelo fluxo existente), pedidos já
 * recebidos (marketplace_order_inbox), envios à ADS (ads_order_submissions), saldo ADS em cache
 * (product_stocks) ou ao vivo (GET /estoques, opcional e limitado — sem gravar no cache existente).
 * Calcula: compromissos, posição segura, cotas por canal (Mercado Livre real, Nuvemshop simulada),
 * propostas e divergências.
 * Grava: SOMENTE tabelas inventory_*. Nenhuma escrita no Mercado Livre, na Nuvemshop ou na ADS; o
 * sincronizador atual não é chamado nem alterado.
 */
const LEASE = "inventory-shadow";
const CHANNELS = ["mercadolivre", "nuvemshop"] as const;

/**
 * Nuvemshop no núcleo (Fase 2): com a automação de estoque Nuvemshop fora de DISABLED e a loja conectada, o canal
 * deixa de ser simulado — a cota da Nuvemshop é calculada AQUI (planQuotas, cotas exclusivas, folga não exposta) e
 * gravada como proposta por variante (inventory_sync_proposals, canal nuvemshop). O conector Nuvemshop só lê
 * essa proposta e escreve pela fila própria; o núcleo continua sem nenhuma escrita remota.
 */
async function nuvemshopStockMode(sql: Sql): Promise<string> {
  const [row] = await sql.query<{ mode: string }>(`SELECT mode FROM nuvemshop_automation_settings WHERE kind = 'STOCK'`).catch(() => []);
  return row?.mode ?? "DISABLED";
}

export interface ShadowRunOptions {
  requestedBy: string;
  /** Consulta o saldo ao vivo na ADS (somente GET), até settings.liveAdsMaxProducts produtos. */
  live?: boolean;
  /** Restringe a estes produtos (execução parcial: não encerra divergências de outros). */
  productIds?: number[];
  deadline?: number;
  now?: Date;
}

export interface ShadowRunResult {
  runId: string;
  status: "COMPLETED" | "PARTIAL";
  summary: Record<string, unknown>;
}

interface DiscrepancyInput {
  fingerprint: string;
  poolId?: string | null;
  productId?: number | null;
  channel?: string | null;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
  details?: unknown;
}

interface StockRow {
  productId: number;
  branchId: string;
  quantity: string;
  fetchedAt: Date;
}

interface LiveStock {
  status: "KNOWN" | "ERROR";
  rows: { branchId: string; quantity: string }[];
  fetchedAt: Date;
  error?: string;
}

const timeLeft = (deadline?: number) => (deadline === undefined ? Infinity : deadline - Date.now());

export async function runShadowReconciliation(sql: Sql, opts: ShadowRunOptions): Promise<ShadowRunResult> {
  assertInventoryEnabled();
  const owner = randomUUID();
  if (!(await acquireLease(sql, owner, LEASE))) throw new InventoryError("already_running", "Outra reconciliação do Inventory Core está em andamento", 409);
  const correlationId = randomUUID();
  let runId = "";
  try {
    [{ id: runId }] = await sql.query<{ id: string }>(
      `INSERT INTO inventory_reconciliation_runs (source, requested_by, correlation_id) VALUES ($1::text, $2::text, $3::text) RETURNING id::text AS id`,
      [opts.live ? "ADS_LIVE" : "ADS_CACHE", opts.requestedBy, correlationId],
    );
    const r = await execute(sql, runId, correlationId, opts);
    await sql.execute(`UPDATE inventory_reconciliation_runs SET status = $2::text, finished_at = now(), summary = $3::jsonb WHERE id = $1::uuid`, [runId, r.status, JSON.stringify(r.summary)]);
    return { runId, ...r };
  } catch (err) {
    logger.error("Falha na reconciliação do Inventory Core", { runId, err });
    if (runId) {
      await sql
        .execute(`UPDATE inventory_reconciliation_runs SET status = 'FAILED', finished_at = now(), error_message = $2::text WHERE id = $1::uuid`, [runId, err instanceof Error ? err.message.slice(0, 500) : "erro"])
        .catch(() => undefined);
    }
    throw err;
  } finally {
    await releaseLease(sql, owner, LEASE).catch(() => undefined);
  }
}

/**
 * Leitura ao vivo na ADS em lotes de 20, sem passar de `liveDeadline`.
 *
 * Produto que não chegou a ser consultado (acabou o tempo reservado à leitura, ou a ADS caiu num lote anterior)
 * fica SEM entrada: o cálculo usa o último saldo conhecido (cache ou snapshot vigente), que envelhece e só permite
 * reduzir. Só o lote que de fato falhou vira ERROR. Antes, uma ADS lenta consumia o prazo inteiro e o núcleo não
 * calculava cota nenhuma (incidente Nuvemshop de 27/11/2026: loja com 10, ADS com 7).
 */
async function fetchLiveStocks(products: SkuRecord[], liveDeadline?: number): Promise<{ live: Map<number, LiveStock>; skipped: number }> {
  const out = new Map<number, LiveStock>();
  for (let i = 0; i < products.length; i += 20) {
    const chunk = products.slice(i, i + 20);
    const fetchedAt = new Date();
    try {
      // Somente leitura (GET). Diferente da sincronização atual, NÃO grava no cache product_stocks.
      const items = await getAllPagesForIds("estoques", chunk.map((p) => p.adsProductId), { deadline: liveDeadline });
      const mapped = mapStocks(items).rows;
      for (const p of chunk) {
        out.set(p.productId, { status: "KNOWN", rows: mapped.filter((r) => r.ads_product_id === p.adsProductId).map((r) => ({ branchId: r.branch_id, quantity: r.quantity })), fetchedAt });
      }
    } catch (err) {
      if (err instanceof AdsNoTimeError) return { live: out, skipped: products.length - i };
      const message = err instanceof Error ? err.message.slice(0, 300) : "Erro na ADS";
      for (const p of chunk) out.set(p.productId, { status: "ERROR", rows: [], fetchedAt, error: message });
      if (isAdsOutage(err)) return { live: out, skipped: products.length - i - chunk.length };
    }
  }
  return { live: out, skipped: 0 };
}

/**
 * Prazo da leitura ao vivo: no máximo metade do tempo restante, deixando ~150 ms por produto (mais folga) para o
 * cálculo dos pools. Sem prazo, sem limite.
 */
export function liveReadDeadline(deadline: number | undefined, products: number, now = Date.now()): number | undefined {
  if (deadline === undefined) return undefined;
  const left = deadline - now;
  return now + Math.max(0, Math.min(left * 0.5, left - products * 150 - 5_000));
}

function snapshotFor(
  productId: number,
  branches: Set<string>,
  cache: StockRow[],
  live: LiveStock | undefined,
): { snapshot: SnapshotInput; source: "ADS_CACHE" | "ADS_LIVE"; used: { branchId: string; quantity: string }[]; outside: string[]; error: string | null } {
  if (live) {
    if (live.status === "ERROR") return { snapshot: { status: "ERROR", quantity: null, fetchedAt: live.fetchedAt }, source: "ADS_LIVE", used: [], outside: [], error: live.error ?? null };
    const used = live.rows.filter((r) => branches.has(r.branchId));
    const outside = live.rows.filter((r) => !branches.has(r.branchId)).map((r) => r.branchId);
    if (!used.length) return { snapshot: { status: "UNKNOWN", quantity: null, fetchedAt: live.fetchedAt }, source: "ADS_LIVE", used, outside, error: null };
    return { snapshot: { status: "KNOWN", quantity: sumDecimal(used.map((u) => u.quantity)), fetchedAt: live.fetchedAt }, source: "ADS_LIVE", used, outside, error: null };
  }
  const rows = cache.filter((r) => r.productId === productId);
  const used = rows.filter((r) => branches.has(r.branchId));
  const outside = rows.filter((r) => !branches.has(r.branchId)).map((r) => r.branchId);
  if (!used.length) return { snapshot: { status: "UNKNOWN", quantity: null, fetchedAt: null }, source: "ADS_CACHE", used: [], outside, error: null };
  const fetchedAt = new Date(Math.min(...used.map((u) => new Date(u.fetchedAt).getTime())));
  return { snapshot: { status: "KNOWN", quantity: sumDecimal(used.map((u) => u.quantity)), fetchedAt }, source: "ADS_CACHE", used: used.map((u) => ({ branchId: u.branchId, quantity: u.quantity })), outside, error: null };
}

/** Soma decimal exata (3 casas) sem ponto flutuante acumulado. */
function sumDecimal(values: string[]): string {
  let milli = 0n;
  for (const v of values) {
    const [int, frac = ""] = v.split(".");
    const neg = int.startsWith("-");
    const m = BigInt(int.replace("-", "") || "0") * 1000n + BigInt((frac + "000").slice(0, 3));
    milli += neg ? -m : m;
  }
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const s = `${abs / 1000n}.${String(abs % 1000n).padStart(3, "0")}`.replace(/\.?0+$/, "");
  return `${neg ? "-" : ""}${s || "0"}`;
}

/** Exposição confirmada no ML de um produto (unidades físicas): anúncios ativos, vínculo confiável, fora do Full. */
function mlExposure(productId: number, listings: ChannelListingInventory[]): { confirmed: number | null; listings: number; full: number; readAt: Date | null } {
  let confirmed: number | null = 0;
  let count = 0;
  let full = 0;
  let readAt: Date | null = null;
  for (const l of listings) {
    const c = l.components.find((x) => x.productId === productId);
    if (!c) continue;
    if (!l.capability.managedByAds) {
      if (l.capability.code === "FULFILLMENT") full += (l.announced ?? 0) * c.quantity;
      continue;
    }
    if (l.status !== "active") continue;
    count++;
    if (l.readAt && (!readAt || l.readAt < readAt)) readAt = l.readAt;
    if (l.announced === null || confirmed === null) confirmed = null;
    else confirmed += l.announced * c.quantity;
  }
  return { confirmed, listings: count, full, readAt };
}

async function execute(sql: Sql, runId: string, correlationId: string, opts: ShadowRunOptions): Promise<{ status: "COMPLETED" | "PARTIAL"; summary: Record<string, unknown> }> {
  const now = opts.now ?? new Date();
  const settings = await getInventorySettings(sql);
  const stockSettings = await getStockSettings(sql);
  if (opts.live) {
    const hours = adsHoursState(stockSettings);
    if (!hours.open) throw new InventoryError("ads_closed", hours.reason ?? "Fora do horário de funcionamento da ADS", 409);
  }
  const locations = await discoverLocations(sql);
  const ml = new MercadoLivreInventoryAdapter(sql);
  const listings = await ml.getChannelInventory();
  const mappings = await ml.getProductMappings();
  // Nuvemshop (Fase 1): somente leitura do catálogo importado — quantidade observada por variante vinculada.
  // A cota da Nuvemshop continua SIMULADA (não há caminho de escrita); o observado entra na exposição atual.
  const nsAdapter = new NuvemshopInventoryAdapter(sql, settings.channelWarehouses.nuvemshop ?? "principal");
  const nsState = await nsAdapter.state();
  const nsListings = nsState.connected ? await nsAdapter.getChannelInventory() : [];
  const nsMappings = nsState.connected ? await nsAdapter.getProductMappings() : [];
  const nsMode = nsState.connected ? await nuvemshopStockMode(sql) : "DISABLED";
  const nsIntegrated = nsState.connected && nsMode !== "DISABLED";
  const nsWritable = nsIntegrated && (nsMode === "PILOT" || nsMode === "AUTOMATIC");
  const ingest = await ingestMercadoLivreOrders(sql, { settings, correlationId, now });

  // Escopo: produtos vinculados a anúncios, com pedidos, com política própria ou já conhecidos do núcleo.
  const known = await sql.query<{ productId: number; computedAt: Date | null }>(`SELECT product_id AS "productId", min(computed_at) AS "computedAt" FROM inventory_pools GROUP BY 1`);
  const policyProducts = await sql.query<{ productId: number }>(`SELECT product_id AS "productId" FROM inventory_allocation_policies WHERE active AND scope = 'PRODUCT'`);
  let productIds = [
    ...new Set([...listings.flatMap((l) => l.components.map((c) => c.productId)), ...nsListings.flatMap((l) => l.components.map((c) => c.productId)), ...ingest.productIds, ...policyProducts.map((p) => p.productId), ...known.map((k) => k.productId)]),
  ];
  if (opts.productIds?.length) productIds = [...new Set(opts.productIds)];
  // Rodízio: os pools calculados há mais tempo primeiro (execução que estoura o prazo continua na próxima).
  const lastComputed = new Map(known.map((k) => [k.productId, k.computedAt ? new Date(k.computedAt).getTime() : 0]));
  productIds.sort((a, b) => (lastComputed.get(a) ?? -1) - (lastComputed.get(b) ?? -1) || a - b);
  const skus = await ensureSkus(sql, productIds);
  productIds = productIds.filter((id) => skus.has(id));

  const cache = await sql.query<StockRow>(
    `SELECT product_id AS "productId", branch_id AS "branchId", trim_scale(quantity)::text AS quantity, fetched_at AS "fetchedAt" FROM product_stocks WHERE product_id = ANY($1::int[])`,
    [productIds],
  );
  let live = new Map<number, LiveStock>();
  let liveSkipped = 0;
  if (opts.live) {
    const withListings = new Set(listings.flatMap((l) => l.components.map((c) => c.productId)));
    const order = [...productIds].sort((a, b) => Number(withListings.has(b)) - Number(withListings.has(a)));
    const fetched = await fetchLiveStocks(order.slice(0, settings.liveAdsMaxProducts).map((id) => skus.get(id)!), liveReadDeadline(opts.deadline, productIds.length));
    live = fetched.live;
    liveSkipped = fetched.skipped;
  }
  const policies = await effectivePolicies(sql, productIds);
  const legacyPending = await pendingConsumption(sql, productIds, stockSettings.pendingOrderWindowDays);

  const discrepancies: DiscrepancyInput[] = [];
  const warehouses = [...new Set(CHANNELS.map((c) => settings.channelWarehouses[c] ?? "principal"))];
  const mappedByWarehouse = new Map<string, Set<string>>(warehouses.map((w) => [w, new Set(locations.filter((l) => l.status === "MAPPED" && l.warehouseCode === w).map((l) => l.branchId))]));
  for (const loc of locations.filter((l) => l.status === "UNMAPPED")) {
    discrepancies.push({
      fingerprint: `UNMAPPED_LOCATION:${loc.branchId}`,
      type: "UNMAPPED_LOCATION",
      severity: "WARNING",
      message: `Filial ADS ${loc.branchId} sem mapeamento de depósito: o saldo dela não participa do cálculo`,
      details: { branchId: loc.branchId },
    });
  }
  for (const w of warehouses) {
    if (!mappedByWarehouse.get(w)!.size) {
      discrepancies.push({
        fingerprint: `WAREHOUSE_WITHOUT_BRANCH:${w}`,
        type: "WAREHOUSE_WITHOUT_BRANCH",
        severity: "CRITICAL",
        message: `Nenhuma filial ADS mapeada para o depósito "${w}": todos os pools deste depósito ficam bloqueados`,
        details: { warehouse: w },
      });
    }
  }
  // Pedidos sem vínculo confiável: bloqueiam aumento nos produtos do anúncio e não geram reserva.
  const unmappedByItem = new Map<string, number>();
  for (const u of ingest.unmapped) {
    unmappedByItem.set(u.itemId, (unmappedByItem.get(u.itemId) ?? 0) + 1);
    discrepancies.push({
      fingerprint: `UNMAPPED_ORDER_LINE:${u.orderId}:${u.lineKey}`,
      channel: "mercadolivre",
      type: "UNMAPPED_ORDER_LINE",
      severity: "CRITICAL",
      message: `Pedido ${u.orderId} (anúncio ${u.itemId}) sem produto ADS: a venda não pode ser reservada`,
      details: u,
    });
  }
  for (const m of mappings.filter((x) => x.problem)) {
    discrepancies.push({ fingerprint: `MAPPING_CONFLICT:${m.key}`, channel: "mercadolivre", type: "MAPPING_CONFLICT", severity: "WARNING", message: m.problem!, details: { key: m.key, itemIds: m.itemIds } });
  }
  for (const m of nsMappings.filter((x) => x.problem)) {
    discrepancies.push({ fingerprint: `MAPPING_REVIEW:${m.key}`, channel: "nuvemshop", type: "MAPPING_REVIEW", severity: "WARNING", message: m.problem!, details: { key: m.key, itemIds: m.itemIds } });
  }

  const counters = { pools: 0, reliable: 0, degraded: 0, unknown: 0, blocked: 0, overExposed: 0, snapshotsAccepted: 0, snapshotsIgnoredStale: 0, quotaChanges: 0 };
  const mlQuota = new Map<number, number | null>();
  const nsQuota = new Map<number, number | null>();
  const nsProposals: { poolId: string; poolKey: string; productId: number; current: number | null; target: number | null; status: "SHADOW_ONLY" | "BLOCKED" | "IN_SYNC"; reasonCode: string | null; reason: string | null; reliability: string; allowIncrease: boolean; ruleType: string | null }[] = [];
  const proposals: { poolId: string; productId: number; current: number | null; target: number | null; status: "SHADOW_ONLY" | "BLOCKED" | "IN_SYNC"; reasonCode: string | null; reason: string | null }[] = [];
  let processed = 0;
  for (const productId of productIds) {
    if (timeLeft(opts.deadline) < 4_000) break;
    const sku = skus.get(productId)!;
    const eff = policies.get(productId)!;
    for (const w of warehouses) {
      const channelsHere = CHANNELS.filter((c) => (settings.channelWarehouses[c] ?? "principal") === w);
      const branches = mappedByWarehouse.get(w)!;
      const snap = snapshotFor(productId, branches, cache, live.get(productId));
      const pool = await ensurePool(sql, sku, w);
      const outcome = await withPoolLock(sql, pool.poolKey, (tx) =>
        evaluatePool(tx, { runId, correlationId, now, sku, pool: pool.id, warehouse: w, channelsHere, branches, snap, settings, eff, listings, nsListings, nsConnected: nsState.connected, nsIntegrated, nsWritable, unmappedByItem, legacyPending: legacyPending.get(productId) ?? 0, legacyWindowDays: stockSettings.pendingOrderWindowDays }),
      );
      counters.pools++;
      counters[outcome.position.reliability === "RELIABLE" ? "reliable" : outcome.position.reliability === "DEGRADED" ? "degraded" : outcome.position.reliability === "UNKNOWN" ? "unknown" : "blocked"]++;
      if (outcome.snapshotAccepted) counters.snapshotsAccepted++;
      if (outcome.snapshotIgnored) counters.snapshotsIgnoredStale++;
      if (outcome.plan.overExposedBy > 0) counters.overExposed++;
      counters.quotaChanges += outcome.quotaChanges;
      discrepancies.push(...outcome.discrepancies);
      const mlItem = outcome.plan.items.find((i) => i.channel === "mercadolivre");
      if (mlItem) {
        mlQuota.set(productId, mlItem.desired);
        proposals.push({
          poolId: pool.id,
          productId,
          current: mlItem.confirmed,
          target: mlItem.desired,
          status: mlItem.desired === null ? "BLOCKED" : mlItem.desired === mlItem.confirmed ? "IN_SYNC" : "SHADOW_ONLY",
          reasonCode: mlItem.desired === null ? (outcome.position.reliability === "BLOCKED" ? "POOL_BLOCKED" : "STOCK_UNKNOWN") : mlItem.status,
          reason: mlItem.reason ?? (outcome.position.reasons[0] ?? null),
        });
      }
      const nsItem = nsIntegrated ? outcome.plan.items.find((i) => i.channel === "nuvemshop") : undefined;
      if (nsItem) {
        nsQuota.set(productId, nsItem.desired);
        nsProposals.push({
          poolId: pool.id,
          poolKey: pool.poolKey,
          productId,
          current: nsItem.confirmed,
          target: nsItem.desired,
          status: nsItem.desired === null ? "BLOCKED" : nsItem.desired === nsItem.confirmed ? "IN_SYNC" : "SHADOW_ONLY",
          reasonCode: nsItem.desired === null ? (outcome.position.reliability === "BLOCKED" ? "POOL_BLOCKED" : "STOCK_UNKNOWN") : nsItem.status,
          reason: nsItem.reason ?? (outcome.position.reasons[0] ?? null),
          reliability: outcome.position.reliability,
          allowIncrease: outcome.position.allowIncrease,
          ruleType: eff.policy.rules.find((r) => r.channel === "nuvemshop")?.type ?? null,
        });
      }
    }
    processed++;
  }

  // Tradução da cota do ML (unidades físicas) para cada estoque de anúncio: vários anúncios, kits, limites.
  const listingPools = listings.filter((l) => l.components.length && l.capability.managedByAds && l.status === "active");
  const splitModeOf = (id: number) => policies.get(id)?.splitMode ?? "EXCLUSIVE";
  const targets = distributeWithinChannel(mlQuota, listingPools.map((l) => ({ key: l.key, components: l.components, maxQuantity: l.maxQuantity })), splitModeOf);
  const targetByKey = new Map(targets.map((t) => [t.key, t]));
  for (const p of proposals) {
    const mine = listingPools.filter((l) => l.components.some((c) => c.productId === p.productId));
    const details = mine.map((l) => ({ key: l.key, itemIds: l.itemIds, announced: l.announced, target: targetByKey.get(l.key)?.target ?? null, reasonCode: targetByKey.get(l.key)?.reasonCode ?? null, components: l.components }));
    if (mine.length > 1 && splitModeOf(p.productId) !== "SPLIT_EVEN") {
      discrepancies.push({
        fingerprint: `ALLOCATION_REQUIRED:${p.productId}`,
        productId: p.productId,
        poolId: p.poolId,
        channel: "mercadolivre",
        type: "ALLOCATION_REQUIRED",
        severity: "INFO",
        message: `Produto em ${mine.length} estoques independentes no ML: a cota precisa de regra de divisão (SPLIT_EVEN) por anúncio`,
        details: { listings: mine.map((l) => l.key) },
      });
    }
    await sql.execute(
      `INSERT INTO inventory_sync_proposals (run_id, pool_id, channel, current_quantity, target_quantity, direction, status, reason_code, reason, details)
       VALUES ($1::uuid, $2::bigint, 'mercadolivre', $3::int, $4::int, $5::text, $6::text, $7::text, $8::text, $9::jsonb)`,
      [
        runId,
        p.poolId,
        p.current,
        p.target,
        p.target === null || p.current === null ? null : p.target > p.current ? "INCREASE" : p.target < p.current ? "DECREASE" : "NONE",
        p.status,
        p.reasonCode,
        p.reason,
        JSON.stringify({ listings: details }),
      ],
    );
  }

  // Nuvemshop: tradução da cota (unidades físicas por produto) em quantidade por variante — vários anúncios/variantes
  // do mesmo SKU físico nunca multiplicam a cota (sem SPLIT_EVEN a variante fica bloqueada), kits pela composição.
  if (nsIntegrated) {
    const nsPools = nsListings.filter((l) => l.components.length && l.status !== "closed");
    const nsTargets = new Map(distributeWithinChannel(nsQuota, nsPools.map((l) => ({ key: l.key, components: l.components, maxQuantity: l.maxQuantity })), splitModeOf).map((t) => [t.key, t]));
    for (const p of nsProposals) {
      const mine = nsPools.filter((l) => l.components.some((c) => c.productId === p.productId));
      const details = mine.map((l) => ({ key: l.key, itemIds: l.itemIds, announced: l.announced, target: nsTargets.get(l.key)?.target ?? null, reasonCode: nsTargets.get(l.key)?.reasonCode ?? null, components: l.components }));
      await sql.execute(
        `INSERT INTO inventory_sync_proposals (run_id, pool_id, channel, current_quantity, target_quantity, direction, status, reason_code, reason, details)
         VALUES ($1::uuid, $2::bigint, 'nuvemshop', $3::int, $4::int, $5::text, $6::text, $7::text, $8::text, $9::jsonb)`,
        [
          runId,
          p.poolId,
          p.current,
          p.target,
          p.target === null || p.current === null ? null : p.target > p.current ? "INCREASE" : p.target < p.current ? "DECREASE" : "NONE",
          p.status,
          p.reasonCode,
          p.reason,
          JSON.stringify({ listings: details, poolKey: p.poolKey, reliability: p.reliability, allowIncrease: p.allowIncrease, ruleType: p.ruleType, nuvemshopMode: nsMode }),
        ],
      );
    }
  }

  // Compromissos que exigem reconciliação (um alerta por pedido).
  const reconcile = await sql.query<{ externalOrderId: string; channel: string; productId: number; poolId: string; reason: string | null; quantity: string }>(
    `SELECT external_order_id AS "externalOrderId", channel, product_id AS "productId", pool_id::text AS "poolId", state_reason AS reason, trim_scale(quantity)::text AS quantity
     FROM inventory_reservations WHERE state = 'REQUIRES_RECONCILIATION' AND NOT simulated`,
  );
  for (const r of reconcile) {
    discrepancies.push({
      fingerprint: `RESERVATION_RECONCILIATION:${r.channel}:${r.externalOrderId}:${r.productId}`,
      poolId: r.poolId,
      productId: r.productId,
      channel: r.channel,
      type: "RESERVATION_RECONCILIATION",
      severity: "WARNING",
      message: `Pedido ${r.externalOrderId}: ${r.reason ?? "compromisso exige reconciliação"} (continua descontado)`,
      details: r,
    });
  }

  const complete = processed === productIds.length;
  const disc = await persistDiscrepancies(sql, runId, correlationId, discrepancies, { resolveMissing: complete && !opts.productIds?.length });
  const outbox = await drainOutbox(sql);
  return {
    status: complete ? "COMPLETED" : "PARTIAL",
    summary: {
      mode: "SHADOW",
      remoteWrites: 0,
      source: opts.live ? "ADS_LIVE" : "ADS_CACHE",
      // Produtos sem leitura ao vivo nesta execução (tempo ou queda da ADS): calculados pelo último saldo conhecido.
      liveRead: opts.live ? { read: live.size, skipped: liveSkipped } : null,
      products: productIds.length,
      processedProducts: processed,
      ...counters,
      orders: { lines: ingest.lines, reservations: ingest.reservations, created: ingest.created, changed: ingest.changed, unmapped: ingest.unmapped.length, byState: ingest.byState },
      discrepancies: disc,
      outboxSuppressed: outbox.suppressed,
      proposals: { total: proposals.length, shadowOnly: proposals.filter((p) => p.status === "SHADOW_ONLY").length, blocked: proposals.filter((p) => p.status === "BLOCKED").length },
      nuvemshop: { mode: nsMode, integrated: nsIntegrated, proposals: nsProposals.length },
      locations: locations.map((l: LocationRow) => ({ branchId: l.branchId, warehouse: l.warehouseCode, status: l.status })),
      settings: { adsDeductsOnOrderCreated: settings.adsDeductsOnOrderCreated, adsReflectedStatuses: settings.adsReflectedStatuses },
    },
  };
}

interface PoolContext {
  runId: string;
  correlationId: string;
  now: Date;
  sku: SkuRecord;
  pool: string;
  warehouse: string;
  channelsHere: string[];
  branches: Set<string>;
  snap: ReturnType<typeof snapshotFor>;
  settings: InventorySettings;
  eff: { policy: StoredPolicy; safetyReserve: number };
  listings: ChannelListingInventory[];
  /** Variantes Nuvemshop vinculadas (leitura do catálogo importado). */
  nsListings: ChannelListingInventory[];
  nsConnected: boolean;
  /** Automação de estoque Nuvemshop fora de DISABLED: o canal deixa de ser simulado. */
  nsIntegrated: boolean;
  /** Automação em PILOT/AUTOMATIC: o canal é alcançável (escritas pelo conector). */
  nsWritable: boolean;
  unmappedByItem: Map<string, number>;
  legacyPending: number;
  legacyWindowDays: number;
}

interface PoolOutcome {
  position: Position;
  plan: QuotaPlan;
  discrepancies: DiscrepancyInput[];
  snapshotAccepted: boolean;
  snapshotIgnored: boolean;
  quotaChanges: number;
}

async function evaluatePool(tx: Sql, c: PoolContext): Promise<PoolOutcome> {
  const row = await lockPoolRow(tx, c.pool);
  const discrepancies: DiscrepancyInput[] = [];
  const productId = c.sku.productId;
  const base = { poolId: row.id, productId, adsProductId: c.sku.adsProductId, skuCode: c.sku.skuCode, warehouseCode: c.warehouse, correlationId: c.correlationId };

  // 1. Saldo ADS: leitura mais antiga que a vigente não substitui a mais nova (invariante 6).
  let snapshot = c.snap.snapshot;
  let snapshotAccepted = false;
  let snapshotIgnored = false;
  const storedAt = row.adsFetchedAt ? new Date(row.adsFetchedAt) : null;
  const isError = snapshot.status === "ERROR";
  const older = !isError && snapshot.fetchedAt && storedAt && snapshot.fetchedAt.getTime() < storedAt.getTime();
  const unchanged =
    !isError && snapshot.status === row.adsStatus && (snapshot.quantity === null ? row.adsQuantity === null : row.adsQuantity !== null && Number(snapshot.quantity) === Number(row.adsQuantity)) && snapshot.fetchedAt?.getTime() === storedAt?.getTime();
  if (older) {
    snapshotIgnored = true;
    const [s] = await tx.query<{ id: string }>(
      `INSERT INTO inventory_snapshots (pool_id, run_id, source, status, quantity, branches, fetched_at, accepted) VALUES ($1::bigint, $2::uuid, $3::text, $4::text, $5::numeric, $6::jsonb, $7::timestamptz, false) RETURNING id::text AS id`,
      [row.id, c.runId, c.snap.source, snapshot.status, snapshot.quantity === null ? null : String(snapshot.quantity), JSON.stringify(c.snap.used), snapshot.fetchedAt!.toISOString()],
    );
    await recordMovement(tx, { ...base, type: "ADS_STOCK_SNAPSHOT", status: "IGNORED_STALE", origin: "ADS_SNAPSHOT", responsibility: "OBSERVED", quantity: snapshot.quantity, occurredAt: snapshot.fetchedAt, idempotencyKey: `snap:${s.id}`, details: { reason: "Leitura mais antiga que a vigente", storedAt } });
    snapshot = { status: row.adsStatus, quantity: row.adsQuantity, fetchedAt: storedAt };
  } else if (!unchanged && (snapshot.status !== "UNKNOWN" || row.adsStatus !== "UNKNOWN" || snapshot.fetchedAt)) {
    const fetchedAt = snapshot.fetchedAt ?? c.now;
    const [s] = await tx.query<{ id: string }>(
      `INSERT INTO inventory_snapshots (pool_id, run_id, source, status, quantity, branches, fetched_at, accepted, error) VALUES ($1::bigint, $2::uuid, $3::text, $4::text, $5::numeric, $6::jsonb, $7::timestamptz, true, $8::text) RETURNING id::text AS id`,
      [row.id, c.runId, c.snap.source, snapshot.status, snapshot.quantity === null ? null : String(snapshot.quantity), JSON.stringify(c.snap.used), fetchedAt.toISOString(), c.snap.error],
    );
    snapshotAccepted = true;
    await tx.execute(
      // Falha de consulta não apaga o último saldo conhecido nem a data dele (só marca ERROR).
      `UPDATE inventory_pools SET ads_status = $2::text, ads_quantity = CASE WHEN $2::text = 'ERROR' THEN ads_quantity ELSE $3::numeric END,
         ads_fetched_at = CASE WHEN $2::text = 'ERROR' THEN ads_fetched_at ELSE $4::timestamptz END, last_snapshot_id = $5::bigint WHERE id = $1::bigint`,
      [row.id, snapshot.status, snapshot.quantity === null ? null : String(snapshot.quantity), snapshot.fetchedAt?.toISOString() ?? null, s.id],
    );
    await recordMovement(tx, {
      ...base,
      type: "ADS_STOCK_SNAPSHOT",
      status: isError ? "INFORMATIONAL" : "RECORDED",
      origin: "ADS_SNAPSHOT",
      responsibility: "OBSERVED",
      quantity: snapshot.quantity,
      occurredAt: fetchedAt,
      idempotencyKey: `snap:${s.id}`,
      details: { source: c.snap.source, status: snapshot.status, branches: c.snap.used, error: c.snap.error },
    });
  }

  // 2. Compromissos locais deste pool (simulados não entram na posição real).
  const reservations = await tx.query<{ quantity: string; state: "PENDING_ERP" | "REFLECTED_IN_ERP" | "RELEASED" | "REQUIRES_RECONCILIATION" }>(
    `SELECT trim_scale(quantity)::text AS quantity, state FROM inventory_reservations WHERE pool_id = $1::bigint AND NOT simulated`,
    [row.id],
  );

  // 3. Impedimentos e sinais de degradação.
  const blockers: string[] = [];
  const degraders: string[] = [];
  if (!c.branches.size) blockers.push(`Nenhuma filial ADS mapeada para o depósito "${c.warehouse}"`);
  const mine = c.listings.filter((l) => l.components.some((x) => x.productId === productId));
  const unmappedOrders = mine.reduce((a, l) => a + l.itemIds.reduce((b, id) => b + (c.unmappedByItem.get(id) ?? 0), 0), 0);
  if (unmappedOrders) degraders.push(`${unmappedOrders} pedido(s) recente(s) de anúncio deste produto sem vínculo ADS`);
  if (snapshot.status === "KNOWN" && snapshot.quantity !== null && Number(snapshot.quantity) < 0) degraders.push(`Saldo ADS negativo (${snapshot.quantity})`);
  if (c.sku.quantityScale === "DECIMAL") degraders.push("Saldo fracionário na ADS: só unidades inteiras são consideradas");
  const exposureMl = mlExposure(productId, c.listings);
  if (exposureMl.confirmed === null) degraders.push("Quantidade anunciada no ML desconhecida em algum anúncio");

  const position = computePosition({
    snapshot,
    reservations,
    safetyReserve: c.eff.safetyReserve,
    now: c.now,
    maxSnapshotAgeMinutes: c.settings.maxSnapshotAgeMinutes,
    blockers,
    degraders,
  });

  // 4. Cotas por canal (Mercado Livre real, Nuvemshop simulada).
  // Nuvemshop conectada: a quantidade observada (leitura) conta como exposição atual; a cota segue simulada e
  // inalcançável (sem escrita na Fase 1). Sem loja conectada: comportamento da fase 0 (nada anunciado).
  const exposureNs = nsExposure(productId, c.nsListings);
  const nsObserved = c.nsConnected ? (exposureNs.listings > 0 ? exposureNs.confirmed : 0) : null;
  const exposures: ChannelExposure[] = c.channelsHere.map((ch) =>
    ch === "mercadolivre"
      ? { channel: ch, confirmed: exposureMl.confirmed, reachable: true, simulated: false }
      : ch === "nuvemshop" && c.nsConnected
        ? { channel: ch, confirmed: nsObserved, reachable: c.nsWritable, simulated: !c.nsIntegrated }
        : { channel: ch, confirmed: 0, reachable: false, simulated: ch === "nuvemshop" },
  );
  const rules = c.eff.policy.rules.filter((r) => c.channelsHere.includes(r.channel));
  const plan = planQuotas(position.safeSellable, { rules, remainderMode: c.eff.policy.remainderMode }, exposures, { allowIncrease: position.allowIncrease });

  const n = await tx.execute(
    `UPDATE inventory_pools SET pending_commitments = $3::numeric, safety_reserve = $4::int, safe_sellable = $5::int, reliability = $6::text,
       reliability_reasons = $7::jsonb, computed_at = $8::timestamptz, version = version + 1, updated_at = now()
     WHERE id = $1::bigint AND version = $2::int`,
    [row.id, row.version, String(position.pendingCommitments), position.safetyReserve, position.safeSellable, position.reliability, JSON.stringify(position.reasons), c.now.toISOString()],
  );
  if (n !== 1) throw new InventoryError("pool_version_conflict", `Pool ${row.poolKey} alterado em paralelo`, 409);
  const poolVersion = row.version + 1;

  let quotaChanges = 0;
  for (const item of plan.items) {
    const [prev] = await tx.query<{ desired: number | null; confirmed: number | null; status: string; version: number }>(
      `SELECT desired_quantity AS desired, confirmed_quantity AS confirmed, status, version FROM inventory_channel_allocations WHERE pool_id = $1::bigint AND channel = $2::text FOR UPDATE`,
      [row.id, item.channel],
    );
    const simulated = item.channel === "nuvemshop" && !c.nsIntegrated;
    const confirmedAt = item.channel === "mercadolivre" ? exposureMl.readAt : item.channel === "nuvemshop" && c.nsIntegrated ? (c.nsListings.find((l) => l.components.some((x) => x.productId === productId))?.readAt ?? null) : null;
    if (prev && prev.desired === item.desired && prev.confirmed === item.confirmed && prev.status === item.status) continue;
    await tx.execute(
      `INSERT INTO inventory_channel_allocations (pool_id, channel, desired_quantity, confirmed_quantity, confirmed_at, pending_quantity, status, simulated, policy_id, policy_version, computed_at)
       VALUES ($1::bigint, $2::text, $3::int, $4::int, $5::timestamptz, $6::int, $7::text, $8::boolean, $9::bigint, $10::int, $11::timestamptz)
       ON CONFLICT (pool_id, channel) DO UPDATE SET desired_quantity = EXCLUDED.desired_quantity, confirmed_quantity = EXCLUDED.confirmed_quantity,
         confirmed_at = EXCLUDED.confirmed_at, pending_quantity = EXCLUDED.pending_quantity, status = EXCLUDED.status, policy_id = EXCLUDED.policy_id,
         policy_version = EXCLUDED.policy_version, computed_at = EXCLUDED.computed_at, version = inventory_channel_allocations.version + 1, updated_at = now()`,
      [row.id, item.channel, item.desired, item.confirmed, confirmedAt?.toISOString() ?? null, item.pending, item.status, simulated, c.eff.policy.id, c.eff.policy.version, c.now.toISOString()],
    );
    if (!prev || prev.desired !== item.desired) {
      quotaChanges++;
      const key = `alloc:${row.id}:${item.channel}:${poolVersion}`;
      await recordMovement(tx, {
        ...base,
        type: "QUOTA_ALLOCATED",
        channel: item.channel,
        quantity: item.desired,
        origin: "INVENTORY_CORE",
        responsibility: "INTERNAL",
        simulated,
        idempotencyKey: key,
        details: { previous: prev?.desired ?? null, desired: item.desired, confirmed: item.confirmed, status: item.status, reason: item.reason, nature: "Limite de exposição comercial (não é reserva física no ERP)", policyVersion: c.eff.policy.version },
      });
      // Outbox na mesma transação da mudança: um futuro despachante publicaria; na fase 0 é suprimido.
      await enqueueOutbox(tx, { aggregateType: "inventory_pool", aggregateId: row.id, eventType: "QUOTA_CHANGED", payload: { poolKey: row.poolKey, channel: item.channel, desired: item.desired, confirmed: item.confirmed, simulated }, idempotencyKey: key });
    }
  }

  // 5. Divergências deste pool.
  const where = { poolId: row.id, productId };
  if (position.reliability === "UNKNOWN") {
    discrepancies.push(
      snapshot.status === "ERROR"
        ? { ...where, fingerprint: `ADS_UNAVAILABLE:${row.id}`, type: "ADS_UNAVAILABLE", severity: "CRITICAL", message: `Falha ao consultar a ADS (${c.sku.skuCode}): saldo desconhecido, nenhuma cota nova`, details: { error: c.snap.error } }
        : { ...where, fingerprint: `ADS_STOCK_UNKNOWN:${row.id}`, type: "ADS_STOCK_UNKNOWN", severity: "WARNING", message: `Saldo ADS não encontrado para ${c.sku.skuCode} no depósito ${c.warehouse} (não é zero)`, details: { outsideBranches: c.snap.outside } },
    );
  }
  if (c.snap.outside.length) {
    discrepancies.push({ ...where, fingerprint: `STOCK_IN_UNMAPPED_BRANCH:${row.id}`, type: "STOCK_IN_UNMAPPED_BRANCH", severity: "INFO", message: `${c.sku.skuCode} tem saldo em filial fora do depósito ${c.warehouse} (${c.snap.outside.join(", ")}): não somado`, details: { branches: c.snap.outside } });
  }
  const nsCounted = c.channelsHere.includes("nuvemshop") && c.nsConnected && (nsObserved ?? 0) > 0;
  if (plan.overExposedBy > 0) {
    discrepancies.push({
      ...where,
      channel: nsCounted ? null : "mercadolivre",
      fingerprint: `OVER_EXPOSED:${row.id}`,
      type: "OVER_EXPOSED",
      severity: "CRITICAL",
      message: `${c.sku.skuCode}: anunciado ${exposureMl.confirmed} no ML${nsCounted ? ` + ${nsObserved} na Nuvemshop` : ""}, disponível seguro ${position.safeSellable} (excesso ${plan.overExposedBy})`,
      details: { announced: exposureMl.confirmed, nuvemshopObserved: nsCounted ? nsObserved : null, safeSellable: position.safeSellable, pending: position.pendingCommitments, ads: position.adsQuantity, reserve: position.safetyReserve },
    });
  }
  if (c.channelsHere.includes("nuvemshop") && c.nsConnected && exposureNs.listings > 0 && exposureNs.confirmed === null) {
    discrepancies.push({
      ...where,
      channel: "nuvemshop",
      fingerprint: `NS_EXPOSURE_UNKNOWN:${row.id}`,
      type: "NS_EXPOSURE_UNKNOWN",
      severity: "WARNING",
      message: `${c.sku.skuCode}: quantidade na Nuvemshop desconhecida (${exposureNs.unknownReason}) — não entra como zero`,
      details: { reason: exposureNs.unknownReason },
    });
  }
  const pendingNow = Math.ceil(position.pendingCommitments - 1e-9);
  if (pendingNow !== Math.ceil(c.legacyPending - 1e-9)) {
    const more = pendingNow > c.legacyPending;
    discrepancies.push({
      ...where,
      fingerprint: `CURRENT_SYNC_PENDING_DIFFERS:${row.id}`,
      type: "CURRENT_SYNC_PENDING_DIFFERS",
      severity: more ? "WARNING" : "INFO",
      message: more
        ? `${c.sku.skuCode}: o Inventory Core desconta ${pendingNow} un. pendentes e o sincronizador atual ${c.legacyPending} (o atual deixa de descontar após o envio SENT à ADS, sem prova de baixa, e ignora pedidos com mais de ${c.legacyWindowDays} dias)`
        : `${c.sku.skuCode}: o sincronizador atual desconta ${c.legacyPending} un. pendentes e o Inventory Core ${pendingNow}`,
      details: { inventoryCore: position.pendingCommitments, currentSync: c.legacyPending },
    });
  }
  if (position.reliability === "DEGRADED" && position.reasons.some((r) => r.startsWith("Saldo ADS com"))) {
    discrepancies.push({ ...where, fingerprint: `STALE_SNAPSHOT:${row.id}`, type: "STALE_SNAPSHOT", severity: "INFO", message: `${c.sku.skuCode}: ${position.reasons.find((r) => r.startsWith("Saldo ADS com"))}`, details: { ageMinutes: position.snapshotAgeMinutes } });
  }
  return { position, plan, discrepancies, snapshotAccepted, snapshotIgnored, quotaChanges };
}

async function persistDiscrepancies(sql: Sql, runId: string, correlationId: string, list: DiscrepancyInput[], opts: { resolveMissing: boolean }) {
  const unique = new Map(list.map((d) => [d.fingerprint, d]));
  let opened = 0;
  for (const d of unique.values()) {
    const [row] = await sql.query<{ id: string; inserted: boolean }>(
      `INSERT INTO inventory_discrepancies (fingerprint, first_run_id, last_run_id, pool_id, product_id, channel, type, severity, message, details)
       VALUES ($1::text, $2::uuid, $2::uuid, $3::bigint, $4::int, $5::text, $6::text, $7::text, $8::text, $9::jsonb)
       ON CONFLICT (fingerprint) WHERE status = 'OPEN' DO UPDATE SET last_run_id = EXCLUDED.last_run_id, last_seen_at = now(), severity = EXCLUDED.severity,
         message = EXCLUDED.message, details = EXCLUDED.details, occurrences = inventory_discrepancies.occurrences + 1
       RETURNING id::text AS id, (xmax = 0) AS inserted`,
      [d.fingerprint, runId, d.poolId ?? null, d.productId ?? null, d.channel ?? null, d.type, d.severity, d.message, d.details === undefined ? null : JSON.stringify(d.details)],
    );
    if (row.inserted) {
      opened++;
      await recordMovement(sql, { type: "STOCK_DISCREPANCY", poolId: d.poolId ?? null, productId: d.productId ?? null, channel: d.channel ?? null, status: "INFORMATIONAL", origin: "INVENTORY_CORE", responsibility: "INTERNAL", correlationId, idempotencyKey: `disc:${row.id}`, details: { type: d.type, severity: d.severity, message: d.message } });
    }
  }
  let resolved = 0;
  if (opts.resolveMissing) {
    const rows = await sql.query<{ id: string; poolId: string | null; productId: number | null; type: string }>(
      `UPDATE inventory_discrepancies SET status = 'RESOLVED', resolved_at = now() WHERE status = 'OPEN' AND last_run_id IS DISTINCT FROM $1::uuid
       RETURNING id::text AS id, pool_id::text AS "poolId", product_id AS "productId", type`,
      [runId],
    );
    for (const r of rows) {
      resolved++;
      await recordMovement(sql, { type: "STOCK_RECONCILED", poolId: r.poolId, productId: r.productId, status: "INFORMATIONAL", origin: "INVENTORY_CORE", responsibility: "INTERNAL", correlationId, idempotencyKey: `disc:${r.id}:resolved`, details: { type: r.type, note: "Divergência não observada na reconciliação completa" } });
    }
  }
  const [open] = await sql.query<{ critical: number; warning: number; info: number }>(
    `SELECT count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical, count(*) FILTER (WHERE severity = 'WARNING')::int AS warning, count(*) FILTER (WHERE severity = 'INFO')::int AS info
     FROM inventory_discrepancies WHERE status = 'OPEN'`,
  );
  return { observed: unique.size, opened, resolved, open };
}
