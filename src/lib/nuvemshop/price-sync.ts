import "server-only";
import { randomUUID } from "node:crypto";
import { adsHoursState } from "../ads/hours";
import { acquireLease, releaseLease } from "../imports/jobs";
import { logger } from "../logger";
import { raiseAlert } from "../marketplace/alerts";
import type { Sql } from "../sql";
import { DEFAULT_PRICE_SETTINGS, fetchAdsPrices, pickPrice, type AdsPrice } from "../stock/prices";
import type { PriceRow } from "../ads/schemas";
import { getStockSettings } from "../stock/settings";
import { AutomationError, getAutomation, markRunScheduled, recordVariantDecision, RUN_MODES, selectedForWrite, type AutomationMode, type Participation, type PricePolicy } from "./automation";
import { cents, fromCents, refreshProducts, type RemoteVariantState } from "./remote-state";
import { clientForConnectedStore, getConnectedStore } from "./store";
import { hasScope, nuvemshopWriteEnv } from "./write-gate";
import { enqueueWrite, type WorkerDeps } from "./write-jobs";

/**
 * NuvemshopAutomaticPriceSyncService — preço ADS (tabela comercial configurada) → Nuvemshop.
 *
 *  1. lê a tabela comercial ADS configurada (ao vivo, GET);           2. identifica as variantes vinculadas (CONFIRMED);
 *  3. relê o preço atual na Nuvemshop (GET por ids);                    4. aplica a política aprovada (margem, mínimo, arredondamento);
 *  5. identifica divergências;                                          6. prepara a atualização;
 *  7. enfileira (fila persistente);                                     8. o worker atualiza o preço remoto (PATCH stock-price);
 *  9. o worker relê e confirma;                                        10. tudo fica no histórico (runs, items, jobs, tentativas).
 *
 * Origem do preço: no horário da ADS, leitura ao vivo (GET); fora dele, ou se a ADS falhar, o preço da tabela já
 * gravado no sistema (product_prices, atualizado pela importação e pelas leituras ao vivo), desde que lido há no
 * máximo cacheMaxAgeHours — mais antigo fica bloqueado. A origem de cada preço fica registrada no histórico.
 *
 * Regras de segurança: preço ADS ausente/zero/erro nunca é escrito; descontos da ADS NÃO são aplicados (só o preço
 * da tabela); variante com preço promocional não é tocada (BLOCK) ou só tem o preço cheio atualizado se a promoção
 * continuar menor (KEEP); variação acima de maxChangePct vai para revisão manual; kits não são precificados.
 */
export const PRICE_LEASE = "nuvemshop-price-sync";
const MAX_VARIANTS_PER_RUN = 300;

export type PriceDecision = "IN_SYNC" | "WRITE" | "BLOCKED" | "REVIEW";

export interface PriceEvaluation {
  decision: PriceDecision;
  reasonCode: string | null;
  reason: string | null;
  baseCents: number | null;
  targetCents: number | null;
  currentCents: number | null;
  changePct: number | null;
}

/** Preço final a partir do preço da tabela: margem → arredondamento → mínimo. Puro. */
export function computeTargetCents(baseCents: number, p: Pick<PricePolicy, "marginPct" | "rounding" | "minPrice">): number {
  let c = Math.round(baseCents * (1 + (p.marginPct ?? 0) / 100));
  if (p.rounding === "CENTS_90" || p.rounding === "CENTS_99") {
    const end = p.rounding === "CENTS_90" ? 90 : 99;
    let v = Math.floor(c / 100) * 100 + end;
    if (v < c) v += 100;
    c = v;
  } else if (p.rounding === "WHOLE") c = Math.ceil(c / 100) * 100;
  if (p.minPrice !== null && p.minPrice !== undefined) c = Math.max(c, Math.round(p.minPrice * 100));
  return c;
}

/** De onde veio o preço ADS usado na decisão. */
export interface PriceSource {
  source: "LIVE" | "CACHE";
  fetchedAt: string | null;
  /** Preço do banco mais antigo que cacheMaxAgeHours. */
  stale: boolean;
}

export function evaluatePrice(input: { ads: AdsPrice | undefined; remote: RemoteVariantState | undefined; kit: boolean; policy: PricePolicy; source?: PriceSource }): PriceEvaluation {
  const base = { baseCents: null, targetCents: null, currentCents: null, changePct: null };
  const r = input.remote;
  if (!r || r.removed) return { ...base, decision: "BLOCKED", reasonCode: "REMOTE_UNKNOWN", reason: "Variante não encontrada na releitura da Nuvemshop" };
  const currentCents = cents(r.price);
  if (input.kit) return { ...base, currentCents, decision: "BLOCKED", reasonCode: "KIT", reason: "Kit/composição: preço não é derivado de um único produto ADS" };
  const a = input.ads;
  if (a && input.source?.stale) {
    return { ...base, currentCents, decision: "BLOCKED", reasonCode: "ADS_PRICE_STALE", reason: `Preço da tabela gravado no sistema está desatualizado (lido em ${input.source.fetchedAt ?? "?"}, limite ${input.policy.cacheMaxAgeHours} h): não aplicado` };
  }
  if (!a || a.status === "ERROR") return { ...base, currentCents, decision: "BLOCKED", reasonCode: "ADS_ERROR", reason: `Falha ao consultar o preço na ADS${a?.error ? `: ${a.error}` : ""} (nada é escrito)` };
  const adsCents = cents(a.price);
  if (a.status !== "KNOWN" || adsCents === null) return { ...base, currentCents, decision: "BLOCKED", reasonCode: "ADS_PRICE_UNKNOWN", reason: "Produto sem preço ativo na tabela ADS configurada (nunca vira zero)" };
  if (adsCents <= 0) return { ...base, currentCents, baseCents: adsCents, decision: "BLOCKED", reasonCode: "ADS_PRICE_ZERO", reason: "Preço zero/negativo na ADS: não aplicado" };
  const targetCents = computeTargetCents(adsCents, input.policy);
  const promo = cents(r.promotionalPrice);
  const changePct = currentCents && currentCents > 0 ? Math.round((Math.abs(targetCents - currentCents) / currentCents) * 10_000) / 100 : null;
  const out = { baseCents: adsCents, targetCents, currentCents, changePct };
  if (currentCents === targetCents) return { ...out, decision: "IN_SYNC", reasonCode: null, reason: null };
  if (promo !== null && promo > 0) {
    if (input.policy.promotion === "BLOCK") return { ...out, decision: "BLOCKED", reasonCode: "PROMOTION_ACTIVE", reason: `Variante com preço promocional (${fromCents(promo)}): a política não altera produtos em promoção` };
    if (promo >= targetCents) return { ...out, decision: "BLOCKED", reasonCode: "PROMOTION_ABOVE_PRICE", reason: `Promoção (${fromCents(promo)}) ficaria maior ou igual ao novo preço (${fromCents(targetCents)})` };
  }
  if (currentCents === null || currentCents <= 0) return { ...out, decision: "REVIEW", reasonCode: "NO_CURRENT_PRICE", reason: "Variante sem preço atual na Nuvemshop: primeira definição exige revisão" };
  if (changePct !== null && changePct > input.policy.maxChangePct) {
    return { ...out, decision: "REVIEW", reasonCode: "LARGE_CHANGE", reason: `Variação de ${changePct}% acima do limite de ${input.policy.maxChangePct}%: aguarda revisão` };
  }
  return { ...out, decision: "WRITE", reasonCode: null, reason: null };
}

export interface SyncRunResult {
  runId: string | null;
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED" | "BUSY";
  summary: Record<string, unknown>;
}

interface Candidate {
  variantId: string;
  nsProductId: string;
  productId: number;
  components: number;
  nsKit: boolean;
  adsKit: boolean;
  participation: Participation;
  sku: string | null;
}

export async function priceCandidates(sql: Sql, storeId: string, variantIds: string[] | null, limit = MAX_VARIANTS_PER_RUN): Promise<Candidate[]> {
  return sql.query<Candidate>(
    `SELECT m.variant_id::text AS "variantId", m.nuvemshop_product_id::text AS "nsProductId", m.product_id AS "productId",
            (SELECT count(*) FROM nuvemshop_mapping_components c WHERE c.mapping_id = m.id)::int AS components, p.is_kit AS "nsKit",
            COALESCE(ap.raw_payload->>'kit', 'false') = 'true' AS "adsKit", COALESCE(sv.participation, 'NONE') AS participation, v.sku
     FROM nuvemshop_variant_mappings m
     JOIN nuvemshop_variants v ON v.store_id = m.store_id AND v.variant_id = m.variant_id AND v.sync_status = 'ACTIVE'
     JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id AND p.sync_status = 'ACTIVE'
     JOIN products ap ON ap.id = m.product_id
     LEFT JOIN nuvemshop_sync_variants sv ON sv.store_id = m.store_id AND sv.variant_id = m.variant_id AND sv.kind = 'PRICE'
     WHERE m.store_id = $1 AND m.status = 'CONFIRMED' AND ($2::bigint[] IS NULL OR m.variant_id = ANY($2::bigint[]))
     ORDER BY (COALESCE(sv.participation, 'NONE') IN ('PILOT', 'INCLUDED')) DESC, sv.dirty_at DESC NULLS LAST, sv.evaluated_at ASC NULLS FIRST, m.variant_id
     LIMIT $3`,
    [storeId, variantIds?.length ? variantIds : null, limit],
  );
}

/**
 * Uma execução. `simulate` = simulação pedida no painel: calcula tudo e não cria escrita, em qualquer modo.
 * Sem `simulate`, só roda nos modos SHADOW/PILOT/AUTOMATIC; escreve só em PILOT/AUTOMATIC nas variantes selecionadas.
 */
export async function runPriceSync(
  sql: Sql,
  opts: { trigger: "scheduler" | "manual" | "simulation"; requestedBy: string; simulate?: boolean; variantIds?: string[]; deadline?: number; deps?: WorkerDeps },
): Promise<SyncRunResult> {
  const automation = await getAutomation(sql, "PRICE");
  const simulate = opts.simulate === true || opts.trigger === "simulation";
  if (!simulate && !RUN_MODES.includes(automation.mode)) return { runId: null, status: "SKIPPED", summary: { reason: `Automação de preço em ${automation.mode}` } };
  const owner = randomUUID();
  if (!(await acquireLease(sql, owner, PRICE_LEASE))) return { runId: null, status: "BUSY", summary: {} };
  const mode: AutomationMode | "SIMULATION" = simulate ? "SIMULATION" : automation.mode;
  let runId: string | null = null;
  try {
    [{ id: runId }] = await sql.query<{ id: string }>(
      `INSERT INTO nuvemshop_sync_runs (kind, mode, trigger, requested_by) VALUES ('PRICE', $1, $2, $3) RETURNING id::text AS id`,
      [mode, simulate ? "simulation" : opts.trigger, opts.requestedBy],
    );
    const r = await executePrice(sql, runId, mode, automation.scope, automation.policy, simulate, opts);
    await sql.execute(`UPDATE nuvemshop_sync_runs SET status = $2, finished_at = now(), summary = $3::jsonb WHERE id = $1::uuid`, [runId, r.status, JSON.stringify(r.summary)]);
    if (!simulate) await markRunScheduled(sql, "PRICE", runId, automation.intervalMinutes);
    return { runId, ...r };
  } catch (err) {
    logger.error("Falha na sincronização de preço Nuvemshop", { runId, err });
    if (runId) await sql.execute(`UPDATE nuvemshop_sync_runs SET status = 'FAILED', finished_at = now(), error_message = $2 WHERE id = $1::uuid`, [runId, (err as Error).message?.slice(0, 500) ?? "erro"]).catch(() => undefined);
    if (runId && !simulate) await markRunScheduled(sql, "PRICE", runId, automation.intervalMinutes).catch(() => undefined);
    await raiseAlert(sql, "nuvemshop_price_sync_failed", `Sincronização de preço Nuvemshop falhou: ${(err as Error).message}`);
    throw err;
  } finally {
    await releaseLease(sql, owner, PRICE_LEASE).catch(() => undefined);
  }
}

async function executePrice(
  sql: Sql,
  runId: string,
  mode: AutomationMode | "SIMULATION",
  scope: "SELECTED" | "ALL_ELIGIBLE",
  policy: PricePolicy,
  simulate: boolean,
  opts: { requestedBy: string; variantIds?: string[]; deadline?: number; deps?: WorkerDeps },
): Promise<{ status: "COMPLETED" | "PARTIAL" | "SKIPPED"; summary: Record<string, unknown> }> {
  if (!policy.priceTableCode) return { status: "SKIPPED", summary: { reason: "Tabela comercial ADS de referência não configurada" } };
  // Fora do horário da ADS a execução continua: os preços vêm do que já está gravado no sistema (com limite de idade).
  const hours = adsHoursState(await getStockSettings(sql));
  const conn = opts.deps?.client ?? (await clientForConnectedStore(sql, { fetchImpl: opts.deps?.fetchImpl, sleep: opts.deps?.sleep, maxRetries: opts.deps?.maxRetries }));
  const storeId = conn.store.storeId;
  const candidates = await priceCandidates(sql, storeId, opts.variantIds ?? null);
  if (!candidates.length) return { status: "COMPLETED", summary: { variants: 0, note: "Nenhuma variante vinculada" } };

  const remote = (await refreshProducts(sql, conn.client, storeId, [...new Set(candidates.map((c) => c.nsProductId))])).variants;
  const singleProducts = [...new Set(candidates.filter((c) => !c.components && !c.nsKit && !c.adsKit).map((c) => c.productId))];
  const { ads, sources } = await adsPricesFor(sql, singleProducts, policy, { live: hours.open, deadline: opts.deadline });
  const known = [...ads.values()].filter((a) => a.status === "KNOWN").length;
  const errors = [...ads.values()].filter((a) => a.status === "ERROR").length;
  const all = [...sources.values()];
  const origin = { live: all.filter((s) => s.source === "LIVE").length, cache: all.filter((s) => s.source === "CACHE").length, stale: all.filter((s) => s.stale).length };
  if (singleProducts.length && !known && !errors) {
    await raiseAlert(sql, "nuvemshop_price_table_empty", `Nenhum preço encontrado na tabela ADS "${policy.priceTableCode}" para os produtos vinculados à Nuvemshop: confira a tabela configurada`);
  }

  const counts: Record<string, number> = { IN_SYNC: 0, WRITE: 0, SHADOW: 0, BLOCKED: 0, REVIEW: 0, NOT_SELECTED: 0, enqueued: 0, activeJob: 0 };
  const writeMode = mode === "PILOT" || mode === "AUTOMATIC";
  for (const c of candidates) {
    const source = sources.get(c.productId);
    const ev = evaluatePrice({ ads: ads.get(c.productId), remote: remote.get(c.variantId), kit: c.components > 0 || c.nsKit || c.adsKit, policy, source });
    let decision: string = ev.decision;
    let reasonCode = ev.reasonCode;
    let reason = ev.reason;
    let jobId: string | null = null;
    if (ev.decision === "WRITE") {
      if (simulate || mode === "SHADOW") {
        decision = "SHADOW";
        reason = simulate ? "Simulação: nada é escrito" : "Modo sombra: nada é escrito";
      } else if (!writeMode || !selectedForWrite(mode as AutomationMode, scope, c.participation)) {
        decision = "NOT_SELECTED";
        reasonCode = "NOT_SELECTED";
        reason = c.participation === "EXCLUDED" ? "Variante excluída da automação" : mode === "PILOT" ? "Fora do piloto" : "Variante não selecionada para o modo automático";
      } else {
        const q = await enqueueWrite(sql, {
          kind: "PRICE",
          storeId,
          nsProductId: c.nsProductId,
          variantId: c.variantId,
          locationId: null,
          expected: ev.currentCents === null ? null : String(ev.currentCents),
          target: String(ev.targetCents),
          mode: mode === "PILOT" ? "PILOT" : "AUTOMATIC",
          runId,
          createdBy: opts.requestedBy,
        });
        if (q.created) {
          jobId = q.jobId;
          counts.enqueued++;
        } else {
          decision = "BLOCKED";
          reasonCode = q.reason;
          reason = q.reason === "EMERGENCY_STOP" ? "Desligamento de emergência ativo" : "Já existe escrita ativa ou em reconciliação para esta variante";
          counts.activeJob++;
        }
      }
    }
    counts[decision] = (counts[decision] ?? 0) + 1;
    await sql.execute(
      `INSERT INTO nuvemshop_sync_items (run_id, kind, store_id, nuvemshop_product_id, variant_id, product_id, current_value, base_value, target_value, change_pct, decision, reason_code, reason, job_id, details)
       VALUES ($1::uuid, 'PRICE', $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14::jsonb)`,
      [
        runId,
        storeId,
        c.nsProductId,
        c.variantId,
        c.productId,
        ev.currentCents === null ? null : String(ev.currentCents),
        ev.baseCents === null ? null : String(ev.baseCents),
        ev.targetCents === null ? null : String(ev.targetCents),
        ev.changePct,
        decision,
        reasonCode,
        reason,
        jobId,
        JSON.stringify(source ? { priceSource: source.source, priceFetchedAt: source.fetchedAt } : {}),
      ],
    );
    if (!simulate) await recordVariantDecision(sql, { storeId, variantId: c.variantId, kind: "PRICE", decision, reasonCode, reason, target: ev.targetCents === null ? null : String(ev.targetCents), remote: ev.currentCents === null ? null : String(ev.currentCents) });
  }
  return { status: "COMPLETED", summary: { mode, table: policy.priceTableCode, variants: candidates.length, adsLive: hours.open, adsPrices: { known, errors, requested: singleProducts.length, ...origin }, decisions: counts } };
}

/**
 * Preço da tabela por produto: ao vivo na ADS (no horário) e, para o que não veio ao vivo (fora do horário ou ADS com
 * falha), o último valor gravado no sistema — marcado como desatualizado se mais antigo que cacheMaxAgeHours.
 */
export async function adsPricesFor(
  sql: Sql,
  productIds: number[],
  policy: PricePolicy,
  opts: { live: boolean; deadline?: number; now?: Date },
): Promise<{ ads: Map<number, AdsPrice>; sources: Map<number, PriceSource> }> {
  const settings = { ...DEFAULT_PRICE_SETTINGS, priceTableCode: policy.priceTableCode ?? "", branchId: policy.branchId };
  const ads = new Map<number, AdsPrice>();
  const sources = new Map<number, PriceSource>();
  const now = opts.now ?? new Date();
  if (opts.live && productIds.length) {
    const live = await fetchAdsPrices(sql, productIds, settings, { deadline: opts.deadline });
    for (const [id, a] of live) {
      if (a.status === "ERROR") continue; // vai para o valor gravado no sistema
      ads.set(id, a);
      sources.set(id, { source: "LIVE", fetchedAt: now.toISOString(), stale: false });
    }
  }
  const missing = productIds.filter((id) => !ads.has(id));
  if (!missing.length) return { ads, sources };
  const rows = await sql.query<{ productId: number; adsProductId: number; branchId: string; table: string; price: string | null; inactive: boolean; adsUpdatedAt: Date | null; fetchedAt: Date }>(
    `SELECT product_id AS "productId", ads_product_id AS "adsProductId", branch_id AS "branchId", price_table_code AS "table", trim_scale(price)::text AS price, inactive,
            ads_updated_at AS "adsUpdatedAt", fetched_at AS "fetchedAt"
     FROM product_prices WHERE product_id = ANY($1::int[]) AND price_table_code = $2`,
    [missing, settings.priceTableCode],
  );
  for (const id of missing) {
    const mine = rows.filter((r) => r.productId === id);
    if (!mine.length) {
      ads.set(id, { status: "UNKNOWN", price: null, branchId: null, updatedAt: null });
      continue;
    }
    const asRows: PriceRow[] = mine.map((r) => ({
      ads_product_id: r.adsProductId,
      branch_id: r.branchId,
      price_table_code: r.table,
      price: r.price,
      discount: null,
      commission: null,
      ceiling_value: null,
      pvs: null,
      minimum_quantity: null,
      inactive: r.inactive,
      promotion: false,
      ads_updated_at: r.adsUpdatedAt ? new Date(r.adsUpdatedAt).toISOString() : null,
      raw_payload: null,
    }));
    const picked = pickPrice(asRows, mine[0].adsProductId, settings);
    ads.set(id, picked);
    const row = mine.find((r) => r.branchId === picked.branchId);
    if (picked.status === "KNOWN" && row) {
      const fetchedAt = new Date(row.fetchedAt);
      sources.set(id, { source: "CACHE", fetchedAt: fetchedAt.toISOString(), stale: now.getTime() - fetchedAt.getTime() > policy.cacheMaxAgeHours * 3_600_000 });
    }
  }
  return { ads, sources };
}

/** Aprova um item em revisão (variação grande ou primeiro preço): cria uma escrita MANUAL com o mesmo compare-and-set. */
export async function approvePriceReview(sql: Sql, itemId: string, actor: string): Promise<{ jobId: string }> {
  const [item] = await sql.query<{ id: string; runId: string; storeId: string; nsProductId: string; variantId: string; current: string | null; target: string | null; decision: string; createdAt: Date }>(
    `SELECT id::text AS id, run_id::text AS "runId", store_id AS "storeId", nuvemshop_product_id::text AS "nsProductId", variant_id::text AS "variantId",
            current_value AS current, target_value AS target, decision, created_at AS "createdAt"
     FROM nuvemshop_sync_items WHERE id = $1::bigint AND kind = 'PRICE'`,
    [itemId],
  );
  if (!item) throw new AutomationError("item_not_found", "Item não encontrado", 404);
  if (item.decision !== "REVIEW" || !item.target) throw new AutomationError("not_reviewable", "Este item não está aguardando revisão");
  if (Date.now() - new Date(item.createdAt).getTime() > 60 * 60_000) throw new AutomationError("review_expired", "Revisão com mais de 1 hora: rode uma nova simulação antes de aprovar");
  const automation = await getAutomation(sql, "PRICE");
  if (automation.mode === "PAUSED" || automation.mode === "DISABLED") throw new AutomationError("automation_not_active", `Automação de preço em ${automation.mode}: reative antes de aprovar`);
  const q = await enqueueWrite(sql, {
    kind: "PRICE",
    storeId: item.storeId,
    nsProductId: item.nsProductId,
    variantId: item.variantId,
    locationId: null,
    expected: item.current,
    target: item.target,
    mode: "MANUAL",
    runId: item.runId,
    createdBy: actor,
    approvedBy: actor,
  });
  if (!q.created) throw new AutomationError(q.reason === "EMERGENCY_STOP" ? "emergency_stop_active" : "active_job", q.reason === "EMERGENCY_STOP" ? "Desligamento de emergência ativo" : "Já existe escrita ativa para esta variante");
  await sql.execute(`UPDATE nuvemshop_sync_items SET decision = 'APPROVED', approved_by = $2, approved_at = now(), job_id = $3::uuid WHERE id = $1::bigint`, [item.id, actor, q.jobId]);
  return { jobId: q.jobId };
}

/** Pré-condições para ativar PILOT/AUTOMATIC do preço. */
export async function priceActivationBlockers(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  const env = nuvemshopWriteEnv();
  if (!env.enabled) out.push(env.warning ?? "Escrita desligada");
  const store = await getConnectedStore(sql);
  if (!store || store.connectionStatus !== "ACTIVE") out.push("Loja Nuvemshop não conectada");
  else if (!hasScope(store.grantedScopes, "write_products")) out.push("Escopo write_products não concedido");
  const policy = (await getAutomation(sql, "PRICE")).policy;
  if (!policy.priceTableCode) out.push("Tabela comercial ADS de referência não configurada");
  return out;
}
