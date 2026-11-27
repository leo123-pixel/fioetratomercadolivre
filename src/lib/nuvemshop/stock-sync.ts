import "server-only";
import { randomUUID } from "node:crypto";
import { adsHoursState } from "../ads/hours";
import { acquireLease, releaseLease } from "../imports/jobs";
import { MercadoLivreInventoryAdapter } from "../inventory/adapters/mercadolivre";
import { InventoryError, inventoryCoreMode } from "../inventory/mode";
import { getInventorySettings } from "../inventory/settings";
import { runShadowReconciliation } from "../inventory/shadow";
import { logger } from "../logger";
import { raiseAlert } from "../marketplace/alerts";
import type { Sql } from "../sql";
import { autoSyncState, getGroupPolicies, getStockSettings } from "../stock/settings";
import { getAutomation, markRunScheduled, recordVariantDecision, RUN_MODES, selectedForWrite, type AutomationMode, type Participation } from "./automation";
import { nsProductsWithUnmappedOrders, orderProtectionState, productsWithUnconfirmedOrders } from "./orders";
import { refreshProducts, stockAt, type RemoteVariantState } from "./remote-state";
import type { SyncRunResult } from "./price-sync";
import { clientForConnectedStore, getConnectedStore } from "./store";
import { enqueueWrite, type WorkerDeps } from "./write-jobs";
import { hasScope, nuvemshopWriteEnv } from "./write-gate";

/**
 * NuvemshopAutomaticStockSyncService — estoque Inventory Core → Nuvemshop.
 *
 * O conector NÃO calcula cota: a quantidade publicável vem do Inventory Core (saldo ADS do depósito → compromissos
 * ainda não refletidos na ADS, inclusive vendas Nuvemshop → reserva de segurança → política de alocação →
 * cota exclusiva da Nuvemshop, limitada à folga não exposta em outro canal → divisão por variante/kit).
 *
 * Fluxo de uma execução:
 *   1. relê na Nuvemshop as variantes avaliadas (quantidade atual por localização);
 *   2. roda a reconciliação do Inventory Core só para esses produtos (saldo ADS ao vivo no horário da ADS;
 *      fora dele, o saldo em cache envelhece e o núcleo só permite reduzir);
 *   3. lê a cota por variante calculada pelo núcleo;
 *   4. aplica as travas do canal (vínculo, localização ↔ depósito, controle de estoque, proteção de pedidos,
 *      vendas sem baixa confirmada, escritor concorrente no ML) — reduções sempre podem; aumentos só sem trava;
 *   5. enfileira a escrita (PILOT/AUTOMATIC nas variantes selecionadas) — o worker relê, escreve e confirma.
 *
 * Coexistência com o Mercado Livre: enquanto o sincronizador atual do ML estiver escrevendo o estoque de um
 * produto (automação ligada para ele ou ajuste manual em andamento), a Nuvemshop NÃO aumenta o estoque desse
 * produto: o ML pode passar a anunciar o saldo inteiro a qualquer momento. Ver o plano de transferência de
 * responsabilidade em docs/nuvemshop-fase2.md.
 */
export const STOCK_LEASE = "nuvemshop-stock-sync";
/**
 * Variantes por execução. Com 300 o Inventory Core não terminava no tempo do ciclo (0 a 207 produtos calculados por
 * execução em 27/11/2026) e quase todas ficavam sem cota; 150 cabe no orçamento do passo de estoque.
 */
export const MAX_VARIANTS_PER_RUN = 150;
/** Tempo reservado, depois do Inventory Core, para avaliar e registrar cada variante (≈2 consultas por variante). */
const evaluationReserveMs = (variants: number) => 4_000 + variants * 40;

export interface StockProposal {
  target: number | null;
  reasonCode: string | null;
  reason: string | null;
  allowIncrease: boolean;
  ruleZero: boolean;
  reliability: string;
  productIds: number[];
}

export interface StockEvaluationInput {
  remote: RemoteVariantState | undefined;
  location: { locationId: string | null; problem: { code: string; reason: string } | null };
  proposal: StockProposal | undefined;
  /** Motivos que impedem AUMENTO (reduções continuam permitidas). */
  increaseBlockers: string[];
}

export interface StockEvaluation {
  decision: "IN_SYNC" | "WRITE" | "BLOCKED";
  reasonCode: string | null;
  reason: string | null;
  current: number | null;
  target: number | null;
}

/** Decisão por variante (pura). Nunca escreve desconhecido como zero; nunca aumenta com trava ativa. */
export function evaluateStock(i: StockEvaluationInput): StockEvaluation {
  const base = { current: null, target: null };
  if (!i.remote || i.remote.removed) return { ...base, decision: "BLOCKED", reasonCode: "REMOTE_UNKNOWN", reason: "Variante não encontrada na releitura da Nuvemshop" };
  if (i.location.problem) return { ...base, decision: "BLOCKED", reasonCode: i.location.problem.code, reason: i.location.problem.reason };
  if (i.remote.stockManagement !== true) return { ...base, decision: "BLOCKED", reasonCode: "UNMANAGED", reason: "Estoque não controlado (ilimitado) ou não informado na Nuvemshop: o integrador não liga o controle sozinho" };
  const current = stockAt(i.remote, i.location.locationId);
  if (current === null) return { ...base, decision: "BLOCKED", reasonCode: "REMOTE_UNKNOWN", reason: "Quantidade atual na localização desconhecida (não é tratada como zero)" };
  const p = i.proposal;
  if (!p) return { current, target: null, decision: "BLOCKED", reasonCode: "NO_QUOTA", reason: "O Inventory Core não calculou cota para esta variante nesta execução" };
  if (p.ruleZero) return { current, target: null, decision: "BLOCKED", reasonCode: "POLICY_ZERO", reason: "A política do Inventory Core dá cota ZERO à Nuvemshop: defina percentual ou quantidade fixa antes do piloto" };
  if (p.target === null) return { current, target: null, decision: "BLOCKED", reasonCode: p.reasonCode ?? "QUOTA_UNKNOWN", reason: p.reason ?? "Cota desconhecida (saldo ADS ou divisão indisponível): nenhuma escrita" };
  if (!Number.isInteger(p.target) || p.target < 0) return { current, target: null, decision: "BLOCKED", reasonCode: "INVALID_QUOTA", reason: `Cota inválida (${p.target})` };
  if (p.target === current) return { current, target: p.target, decision: "IN_SYNC", reasonCode: null, reason: null };
  if (p.target > current) {
    const blockers = [...i.increaseBlockers];
    if (!p.allowIncrease) blockers.push("Dados do Inventory Core sem confiabilidade para aumento");
    if (blockers.length) return { current, target: p.target, decision: "BLOCKED", reasonCode: "INCREASE_BLOCKED", reason: `Aumento ${current} → ${p.target} bloqueado: ${blockers.join("; ")}` };
  }
  return { current, target: p.target, decision: "WRITE", reasonCode: p.target < current ? "DECREASE" : "INCREASE", reason: null };
}

interface Candidate {
  variantId: string;
  nsProductId: string;
  participation: Participation;
  components: { productId: number; quantity: number }[];
}

async function stockCandidates(sql: Sql, storeId: string, variantIds: string[] | null): Promise<Candidate[]> {
  return sql.query<Candidate>(
    `SELECT m.variant_id::text AS "variantId", m.nuvemshop_product_id::text AS "nsProductId", COALESCE(sv.participation, 'NONE') AS participation,
            COALESCE((SELECT json_agg(json_build_object('productId', c.product_id, 'quantity', c.quantity)) FROM nuvemshop_mapping_components c WHERE c.mapping_id = m.id),
                     json_build_array(json_build_object('productId', m.product_id, 'quantity', 1))) AS components
     FROM nuvemshop_variant_mappings m
     JOIN nuvemshop_variants v ON v.store_id = m.store_id AND v.variant_id = m.variant_id AND v.sync_status = 'ACTIVE'
     JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id AND p.sync_status = 'ACTIVE'
     LEFT JOIN nuvemshop_sync_variants sv ON sv.store_id = m.store_id AND sv.variant_id = m.variant_id AND sv.kind = 'STOCK'
     WHERE m.store_id = $1 AND m.status = 'CONFIRMED' AND ($2::bigint[] IS NULL OR m.variant_id = ANY($2::bigint[]))
     ORDER BY (COALESCE(sv.participation, 'NONE') IN ('PILOT', 'INCLUDED')) DESC, sv.dirty_at DESC NULLS LAST, sv.evaluated_at ASC NULLS FIRST, m.variant_id
     LIMIT $3`,
    [storeId, variantIds?.length ? variantIds : null, MAX_VARIANTS_PER_RUN],
  );
}

/** Localização onde a Nuvemshop recebe o estoque do depósito do canal: exatamente uma associada. */
export async function resolveWriteLocation(sql: Sql, storeId: string, warehouse: string): Promise<{ locationId: string | null; problem: { code: string; reason: string } | null }> {
  const locs = await sql.query<{ locationId: string }>(
    `SELECT location_id AS "locationId" FROM nuvemshop_locations WHERE store_id = $1 AND mapping_status = 'MAPPED' AND warehouse_code = $2 AND removed_at IS NULL ORDER BY location_id`,
    [storeId, warehouse],
  );
  if (!locs.length) return { locationId: null, problem: { code: "NO_LOCATION", reason: `Nenhuma localização Nuvemshop associada ao depósito "${warehouse}" (Nuvemshop › Localizações)` } };
  if (locs.length > 1) return { locationId: null, problem: { code: "MULTIPLE_LOCATIONS", reason: `${locs.length} localizações associadas ao depósito "${warehouse}": a cota não é dividida entre localizações — associe só uma` } };
  return { locationId: locs[0].locationId, problem: null };
}

/**
 * Produtos cujo estoque no ML é escrito pelo sincronizador atual (automação ligada para o produto ou ajuste
 * manual em andamento). Enquanto isso valer, a Nuvemshop não aumenta o estoque deles.
 */
export async function mlLegacyWriters(sql: Sql, productIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!productIds.length) return out;
  const wanted = new Set(productIds);
  const settings = await getStockSettings(sql);
  const auto = autoSyncState(settings).active;
  const groups = await getGroupPolicies(sql, productIds);
  const listings = await new MercadoLivreInventoryAdapter(sql).getChannelInventory({ productIds });
  const activeJobs = new Set((await sql.query<{ poolKey: string }>(`SELECT DISTINCT pool_key AS "poolKey" FROM stock_sync_jobs WHERE status IN ('QUEUED', 'RUNNING')`)).map((r) => r.poolKey));
  for (const l of listings) {
    if (!l.capability.managedByAds || l.status === "closed") continue;
    for (const c of l.components) {
      if (!wanted.has(c.productId) || out.has(c.productId)) continue;
      if (activeJobs.has(l.key)) out.set(c.productId, `ajuste de estoque no Mercado Livre em andamento (${l.itemIds[0]})`);
      else if (auto && (settings.autoSyncScope === "ALL_LINKED" || groups.get(c.productId)?.autoSyncApproved)) out.set(c.productId, `estoque no Mercado Livre (${l.itemIds[0]}) controlado pelo sincronizador atual`);
    }
  }
  return out;
}

/** Pré-condições para ativar PILOT/AUTOMATIC do estoque. */
export async function stockActivationBlockers(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  if (inventoryCoreMode().mode !== "shadow") out.push("INVENTORY_CORE_MODE precisa estar em shadow (o Inventory Core calcula as cotas)");
  const env = nuvemshopWriteEnv();
  if (!env.enabled) out.push(env.warning ?? "Escrita desligada");
  const store = await getConnectedStore(sql);
  if (!store || store.connectionStatus !== "ACTIVE") {
    out.push("Loja Nuvemshop não conectada");
    return out;
  }
  if (!hasScope(store.grantedScopes, "write_products")) out.push("Escopo write_products não concedido");
  const protection = await orderProtectionState(sql, store);
  if (!protection.ready) out.push(`Proteção de pedidos não validada: ${protection.reasons.join("; ")}`);
  const settings = await getInventorySettings(sql);
  const loc = await resolveWriteLocation(sql, store.storeId, settings.channelWarehouses.nuvemshop ?? "principal");
  if (loc.problem) out.push(loc.problem.reason);
  return out;
}

export async function runStockSync(
  sql: Sql,
  opts: { trigger: "scheduler" | "manual" | "simulation"; requestedBy: string; simulate?: boolean; variantIds?: string[]; deadline?: number; deps?: WorkerDeps; adsLive?: boolean },
): Promise<SyncRunResult> {
  const automation = await getAutomation(sql, "STOCK");
  const simulate = opts.simulate === true || opts.trigger === "simulation";
  if (!simulate && !RUN_MODES.includes(automation.mode)) return { runId: null, status: "SKIPPED", summary: { reason: `Automação de estoque em ${automation.mode}` } };
  if (inventoryCoreMode().mode !== "shadow") return { runId: null, status: "SKIPPED", summary: { reason: "Inventory Core desativado (INVENTORY_CORE_MODE)" } };
  const owner = randomUUID();
  if (!(await acquireLease(sql, owner, STOCK_LEASE))) return { runId: null, status: "BUSY", summary: {} };
  const mode: AutomationMode | "SIMULATION" = simulate ? "SIMULATION" : automation.mode;
  let runId: string | null = null;
  try {
    [{ id: runId }] = await sql.query<{ id: string }>(
      `INSERT INTO nuvemshop_sync_runs (kind, mode, trigger, requested_by) VALUES ('STOCK', $1, $2, $3) RETURNING id::text AS id`,
      [mode, simulate ? "simulation" : opts.trigger, opts.requestedBy],
    );
    const r = await executeStock(sql, runId, mode, automation.scope, automation.policy, simulate, opts);
    await sql.execute(`UPDATE nuvemshop_sync_runs SET status = $2, finished_at = now(), summary = $3::jsonb, inventory_run_id = $4::uuid WHERE id = $1::uuid`, [runId, r.status, JSON.stringify(r.summary), r.inventoryRunId]);
    if (!simulate) await markRunScheduled(sql, "STOCK", runId, automation.intervalMinutes);
    return { runId, status: r.status, summary: r.summary };
  } catch (err) {
    logger.error("Falha na sincronização de estoque Nuvemshop", { runId, err });
    if (runId) await sql.execute(`UPDATE nuvemshop_sync_runs SET status = 'FAILED', finished_at = now(), error_message = $2 WHERE id = $1::uuid`, [runId, (err as Error).message?.slice(0, 500) ?? "erro"]).catch(() => undefined);
    if (runId && !simulate) await markRunScheduled(sql, "STOCK", runId, automation.intervalMinutes).catch(() => undefined);
    await raiseAlert(sql, "nuvemshop_stock_sync_failed", `Sincronização de estoque Nuvemshop falhou: ${(err as Error).message}`);
    throw err;
  } finally {
    await releaseLease(sql, owner, STOCK_LEASE).catch(() => undefined);
  }
}

async function executeStock(
  sql: Sql,
  runId: string,
  mode: AutomationMode | "SIMULATION",
  scope: "SELECTED" | "ALL_ELIGIBLE",
  policy: { unconfirmedOrderGraceHours: number; maxWritesPerRun: number },
  simulate: boolean,
  opts: { requestedBy: string; variantIds?: string[]; deadline?: number; deps?: WorkerDeps; adsLive?: boolean },
): Promise<{ status: "COMPLETED" | "PARTIAL" | "SKIPPED"; summary: Record<string, unknown>; inventoryRunId: string | null }> {
  const conn = opts.deps?.client ?? (await clientForConnectedStore(sql, { fetchImpl: opts.deps?.fetchImpl, sleep: opts.deps?.sleep, maxRetries: opts.deps?.maxRetries }));
  const storeId = conn.store.storeId;
  const candidates = await stockCandidates(sql, storeId, opts.variantIds ?? null);
  if (!candidates.length) return { status: "COMPLETED", summary: { variants: 0, note: "Nenhuma variante vinculada" }, inventoryRunId: null };

  // 1. Estado remoto atual (o núcleo usa o catálogo local, atualizado aqui).
  const refreshed = await refreshProducts(sql, conn.client, storeId, [...new Set(candidates.map((c) => c.nsProductId))]);
  const productIds = [...new Set(candidates.flatMap((c) => c.components.map((x) => x.productId)))];

  // 2. Cotas pelo Inventory Core (somente estes produtos).
  const stockSettings = await getStockSettings(sql);
  // Saldo ADS ao vivo (GET) no horário da ADS; fora dele, o cache (que envelhece e só permite reduzir).
  const live = opts.adsLive ?? adsHoursState(stockSettings).open;
  let inventoryRunId: string;
  let inventoryPartial: boolean;
  try {
    const core = await runShadowReconciliation(sql, {
      requestedBy: `nuvemshop-stock:${opts.requestedBy}`,
      live,
      productIds,
      deadline: opts.deadline === undefined ? undefined : opts.deadline - evaluationReserveMs(candidates.length),
    });
    inventoryRunId = core.runId;
    inventoryPartial = core.status === "PARTIAL";
  } catch (err) {
    if (err instanceof InventoryError && (err.code === "already_running" || err.code === "ads_closed")) return { status: "SKIPPED", summary: { reason: err.message }, inventoryRunId: null };
    throw err;
  }

  // 3. Cota por variante.
  const rows = await sql.query<{ reasonCode: string | null; reason: string | null; details: { listings?: { key: string; target: number | null; reasonCode: string | null }[]; allowIncrease?: boolean; ruleType?: string | null; reliability?: string } | null; productId: number }>(
    `SELECT sp.reason_code AS "reasonCode", sp.reason, sp.details, ip.product_id AS "productId" FROM inventory_sync_proposals sp JOIN inventory_pools ip ON ip.id = sp.pool_id
     WHERE sp.run_id = $1::uuid AND sp.channel = 'nuvemshop'`,
    [inventoryRunId],
  );
  const proposals = new Map<string, StockProposal>();
  // Produtos que o núcleo calculou nesta execução (os demais ficaram de fora por tempo, se ela foi parcial).
  const computed = new Set(rows.map((r) => r.productId));
  for (const r of rows) {
    for (const l of r.details?.listings ?? []) {
      const prev = proposals.get(l.key);
      const next: StockProposal = {
        target: l.target,
        reasonCode: l.reasonCode ?? (l.target === null ? r.reasonCode : null),
        reason: l.target === null ? (l.reasonCode === "ALLOCATION_REQUIRED" ? "Produto ADS em várias variantes Nuvemshop: defina a divisão (SPLIT_EVEN) no grupo do produto" : r.reason) : null,
        allowIncrease: r.details?.allowIncrease !== false,
        ruleZero: r.details?.ruleType === "ZERO",
        reliability: r.details?.reliability ?? "UNKNOWN",
        productIds: [r.productId],
      };
      if (!prev) proposals.set(l.key, next);
      else
        proposals.set(l.key, {
          target: prev.target === null || next.target === null ? null : Math.min(prev.target, next.target),
          reasonCode: prev.reasonCode ?? next.reasonCode,
          reason: prev.reason ?? next.reason,
          allowIncrease: prev.allowIncrease && next.allowIncrease,
          ruleZero: prev.ruleZero || next.ruleZero,
          reliability: prev.reliability === "RELIABLE" ? next.reliability : prev.reliability,
          productIds: [...prev.productIds, r.productId],
        });
    }
  }

  // 4. Travas do canal.
  const settings = await getInventorySettings(sql);
  const location = await resolveWriteLocation(sql, storeId, settings.channelWarehouses.nuvemshop ?? "principal");
  const protection = await orderProtectionState(sql, conn.store);
  const mlWriters = await mlLegacyWriters(sql, productIds);
  const unconfirmed = await productsWithUnconfirmedOrders(sql, policy.unconfirmedOrderGraceHours);
  const unmappedNs = await nsProductsWithUnmappedOrders(sql, storeId);

  const counts: Record<string, number> = { IN_SYNC: 0, WRITE: 0, SHADOW: 0, BLOCKED: 0, NOT_SELECTED: 0, enqueued: 0, activeJob: 0, limited: 0, coreTimeLimit: 0 };
  const writeMode = mode === "PILOT" || mode === "AUTOMATIC";
  for (const c of candidates) {
    const key = `ns:${storeId}:${c.variantId}`;
    const increaseBlockers: string[] = [];
    if (!protection.ready) increaseBlockers.push(`proteção de pedidos não operante (${protection.reasons.join(", ")})`);
    for (const x of c.components) {
      const ml = mlWriters.get(x.productId);
      if (ml) increaseBlockers.push(ml);
      const n = unconfirmed.get(x.productId);
      if (n) increaseBlockers.push(`${n} venda(s) Nuvemshop sem baixa confirmada na ADS além do prazo`);
    }
    if (unmappedNs.has(c.nsProductId)) increaseBlockers.push("pedido recente com variante sem vínculo ADS neste produto");
    let ev = evaluateStock({ remote: refreshed.variants.get(c.variantId), location, proposal: proposals.get(key), increaseBlockers: [...new Set(increaseBlockers)] });
    // O núcleo não chegou a este produto (execução parcial por tempo): não conta como avaliada, volta primeiro na próxima.
    const coreTimedOut = inventoryPartial && !proposals.has(key) && c.components.some((x) => !computed.has(x.productId));
    if (coreTimedOut) ev = { ...ev, decision: "BLOCKED", reasonCode: "CORE_TIME_LIMIT", reason: "O Inventory Core não chegou a este produto no tempo desta execução: fica primeiro na fila da próxima" };
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
      } else if (counts.enqueued >= policy.maxWritesPerRun) {
        decision = "BLOCKED";
        reasonCode = "RUN_LIMIT";
        reason = `Limite de ${policy.maxWritesPerRun} escritas por execução: fica para a próxima`;
        counts.limited++;
      } else {
        const q = await enqueueWrite(sql, {
          kind: "STOCK",
          storeId,
          nsProductId: c.nsProductId,
          variantId: c.variantId,
          locationId: location.locationId,
          expected: String(ev.current),
          target: String(ev.target),
          mode: mode === "PILOT" ? "PILOT" : "AUTOMATIC",
          runId,
          sourceVersion: inventoryRunId,
          createdBy: opts.requestedBy,
        });
        if (q.created) {
          jobId = q.jobId;
          counts.enqueued++;
        } else {
          decision = "BLOCKED";
          reasonCode = q.reason;
          reason = q.reason === "EMERGENCY_STOP" ? "Desligamento de emergência ativo" : "Já existe escrita ativa ou em reconciliação para esta variante/localização";
          counts.activeJob++;
        }
      }
    }
    counts[decision] = (counts[decision] ?? 0) + 1;
    if (coreTimedOut) counts.coreTimeLimit++;
    await sql.execute(
      `INSERT INTO nuvemshop_sync_items (run_id, kind, store_id, nuvemshop_product_id, variant_id, product_id, location_id, current_value, target_value, decision, reason_code, reason, job_id, details)
       VALUES ($1::uuid, 'STOCK', $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13::jsonb)`,
      [runId, storeId, c.nsProductId, c.variantId, c.components[0]?.productId ?? null, location.locationId, ev.current === null ? null : String(ev.current), ev.target === null ? null : String(ev.target), decision, reasonCode, reason, jobId, JSON.stringify({ components: c.components, reliability: proposals.get(key)?.reliability ?? null })],
    );
    if (!simulate && !coreTimedOut) await recordVariantDecision(sql, { storeId, variantId: c.variantId, kind: "STOCK", decision, reasonCode, reason, target: ev.target === null ? null : String(ev.target), remote: ev.current === null ? null : String(ev.current) });
  }
  return {
    status: "COMPLETED",
    inventoryRunId,
    summary: { mode, variants: candidates.length, inventoryRunId, inventoryPartial, adsLive: live, orderProtection: protection, location: location.locationId ?? location.problem?.code, mlLegacyWriterProducts: mlWriters.size, decisions: counts },
  };
}
