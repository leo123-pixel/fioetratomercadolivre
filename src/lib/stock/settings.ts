import "server-only";
import type { Sql } from "../sql";

/**
 * Configurações e políticas da sincronização de estoque ADS → Mercado Livre.
 *
 * A automação exige TRÊS condições independentes (nenhuma vem ligada):
 *   1. variável de ambiente STOCK_AUTO_SYNC_ENABLED=true (decisão de implantação);
 *   2. homologação registrada (pelo menos uma atualização manual verificada com sucesso);
 *   3. ativação explícita pelo administrador nas configurações.
 * E mesmo assim só atua sobre produtos (grupos) aprovados individualmente.
 */
export class StockSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StockSyncError";
  }
}

export interface StockSyncSettings {
  /** Ativação administrativa da automação (padrão: desligada). */
  autoSyncEnabled: boolean;
  /** Intervalo da automação, em minutos. */
  autoSyncIntervalMin: number;
  /** Idade máxima do saldo ADS para permitir AUMENTO do estoque anunciado. */
  maxStockAgeMinutes: number;
  /** Reserva de segurança padrão por produto (unidades). */
  defaultSafetyReserve: number;
  /** Filiais ADS consideradas no saldo (null = todas as devolvidas pela ADS). */
  branchIds: string[] | null;
  /** Janela (dias) de pedidos do ML ainda não refletidos na ADS que são descontados. */
  pendingOrderWindowDays: number;
  /** Máximo de atualizações por execução (manual ou automática). */
  maxJobsPerRun: number;
  /** O administrador confirmou que o saldo da ADS é o estoque efetivamente vendável (reservas incluídas). */
  stockSourceConfirmed: boolean;
  stockSourceConfirmedBy: string | null;
  stockSourceConfirmedAt: string | null;
  /** Homologação do fluxo (exigida para ativar a automação). */
  homologatedAt: string | null;
  homologatedBy: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const DEFAULT_SETTINGS: StockSyncSettings = {
  autoSyncEnabled: false,
  autoSyncIntervalMin: 60,
  maxStockAgeMinutes: 15,
  defaultSafetyReserve: 0,
  branchIds: null,
  pendingOrderWindowDays: 7,
  maxJobsPerRun: 30,
  stockSourceConfirmed: false,
  stockSourceConfirmedBy: null,
  stockSourceConfirmedAt: null,
  homologatedAt: null,
  homologatedBy: null,
  updatedBy: null,
  updatedAt: null,
};

const KEY = "stock_sync_settings";

/** STOCK_AUTO_SYNC_ENABLED=true libera a automação na implantação (padrão: false). */
export function envAutoSyncAllowed(): boolean {
  return process.env.STOCK_AUTO_SYNC_ENABLED?.trim().toLowerCase() === "true";
}

export async function getStockSettings(sql: Sql): Promise<StockSyncSettings> {
  const [row] = await sql.query<{ value: Partial<StockSyncSettings> }>(`SELECT value FROM app_settings WHERE key = $1::text`, [KEY]);
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
}

/** A automação pode rodar agora? Devolve o motivo quando não. */
export function autoSyncState(s: StockSyncSettings): { active: boolean; reason: string | null } {
  if (!envAutoSyncAllowed()) return { active: false, reason: "STOCK_AUTO_SYNC_ENABLED não está definida como true no ambiente" };
  if (!s.stockSourceConfirmed) return { active: false, reason: "Saldo da ADS ainda não confirmado como estoque vendável" };
  if (!s.homologatedAt) return { active: false, reason: "Fluxo ainda não homologado" };
  if (!s.autoSyncEnabled) return { active: false, reason: "Automação desativada nas configurações" };
  return { active: true, reason: null };
}

export interface SettingsPatch {
  autoSyncEnabled?: boolean;
  autoSyncIntervalMin?: number;
  maxStockAgeMinutes?: number;
  defaultSafetyReserve?: number;
  branchIds?: string[] | null;
  pendingOrderWindowDays?: number;
  maxJobsPerRun?: number;
  stockSourceConfirmed?: boolean;
  /** Registra a homologação (exige atualização manual verificada com sucesso). */
  homologate?: boolean;
}

export async function recordHistory(
  sql: Sql,
  e: { type: string; actor: string; itemId?: string | null; variationId?: string | null; productId?: number | null; mappingId?: string | null; jobId?: string | null; details?: unknown },
): Promise<void> {
  await sql.execute(
    `INSERT INTO stock_sync_history (event_type, actor, marketplace_item_id, variation_id, product_id, mapping_id, job_id, details)
     VALUES ($1::text, $2::text, $3::text, $4::text, $5::int, $6::bigint, $7::uuid, $8::jsonb)`,
    [e.type, e.actor, e.itemId ?? null, e.variationId ?? null, e.productId ?? null, e.mappingId ?? null, e.jobId ?? null, e.details === undefined ? null : JSON.stringify(e.details)],
  );
}

export async function updateStockSettings(sql: Sql, patch: SettingsPatch, actor: string): Promise<StockSyncSettings> {
  const current = await getStockSettings(sql);
  const next: StockSyncSettings = { ...current };
  const now = new Date().toISOString();
  for (const k of ["autoSyncIntervalMin", "maxStockAgeMinutes", "defaultSafetyReserve", "pendingOrderWindowDays", "maxJobsPerRun"] as const) {
    if (patch[k] !== undefined) next[k] = patch[k]!;
  }
  if (patch.branchIds !== undefined) next.branchIds = patch.branchIds && patch.branchIds.length ? [...new Set(patch.branchIds)] : null;
  if (patch.stockSourceConfirmed !== undefined) {
    next.stockSourceConfirmed = patch.stockSourceConfirmed;
    next.stockSourceConfirmedBy = patch.stockSourceConfirmed ? actor : null;
    next.stockSourceConfirmedAt = patch.stockSourceConfirmed ? now : null;
    // Sem a confirmação da origem não há automação.
    if (!patch.stockSourceConfirmed) next.autoSyncEnabled = false;
  }
  if (patch.homologate) {
    const [ok] = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_sync_jobs WHERE sync_mode = 'MANUAL' AND status = 'SUCCEEDED'`);
    if (!ok?.n) throw new StockSyncError("homologation_required", "Homologue primeiro: faça ao menos uma atualização manual de estoque verificada com sucesso");
    next.homologatedAt = now;
    next.homologatedBy = actor;
  }
  if (patch.autoSyncEnabled !== undefined) {
    if (patch.autoSyncEnabled) {
      if (!envAutoSyncAllowed()) throw new StockSyncError("auto_sync_env_disabled", "A automação está bloqueada no ambiente (STOCK_AUTO_SYNC_ENABLED diferente de true)");
      if (!next.stockSourceConfirmed) throw new StockSyncError("stock_source_unconfirmed", "Confirme antes que o saldo da ADS corresponde ao estoque vendável");
      if (!next.homologatedAt) throw new StockSyncError("homologation_required", "Registre a homologação do fluxo antes de ativar a automação");
    }
    next.autoSyncEnabled = patch.autoSyncEnabled;
  }
  next.updatedBy = actor;
  next.updatedAt = now;
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1::text, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(next)],
  );
  const changed = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await recordHistory(sql, { type: "settings_changed", actor, details: changed });
  return next;
}

// ---------------------------------------------------------------------------
// Política por produto ADS (grupo de estoque).
// ---------------------------------------------------------------------------

export type AllocationMode = "EXCLUSIVE" | "SPLIT_EVEN";

export interface GroupPolicy {
  productId: number;
  adsProductId: number;
  safetyReserve: number | null;
  allocationMode: AllocationMode;
  autoSyncApproved: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  notes: string | null;
}

export async function getGroupPolicies(sql: Sql, productIds: number[]): Promise<Map<number, GroupPolicy>> {
  if (!productIds.length) return new Map();
  const rows = await sql.query<GroupPolicy>(
    `SELECT product_id AS "productId", ads_product_id AS "adsProductId", safety_reserve AS "safetyReserve", allocation_mode AS "allocationMode",
            auto_sync_approved AS "autoSyncApproved", approved_by AS "approvedBy", approved_at AS "approvedAt", notes
     FROM stock_sync_groups WHERE product_id = ANY($1::int[])`,
    [productIds],
  );
  return new Map(rows.map((r) => [r.productId, r]));
}

export interface GroupPatch {
  safetyReserve?: number | null;
  allocationMode?: AllocationMode;
  autoSyncApproved?: boolean;
  notes?: string | null;
}

export async function updateGroupPolicy(sql: Sql, productId: number, patch: GroupPatch, actor: string): Promise<GroupPolicy> {
  const [product] = await sql.query<{ adsProductId: number }>(`SELECT ads_product_id AS "adsProductId" FROM products WHERE id = $1::int`, [productId]);
  if (!product) throw new StockSyncError("product_not_found", "Produto ADS não encontrado", 404);
  const current = (await getGroupPolicies(sql, [productId])).get(productId);
  const merged = {
    safetyReserve: patch.safetyReserve !== undefined ? patch.safetyReserve : (current?.safetyReserve ?? null),
    allocationMode: patch.allocationMode ?? current?.allocationMode ?? "EXCLUSIVE",
    autoSyncApproved: patch.autoSyncApproved ?? current?.autoSyncApproved ?? false,
    notes: patch.notes !== undefined ? patch.notes : (current?.notes ?? null),
  };
  const approvalChanged = patch.autoSyncApproved !== undefined && patch.autoSyncApproved !== (current?.autoSyncApproved ?? false);
  await sql.execute(
    `INSERT INTO stock_sync_groups (product_id, ads_product_id, safety_reserve, allocation_mode, auto_sync_approved, approved_by, approved_at, notes, updated_by, updated_at)
     VALUES ($1::int, $2::int, $3::int, $4::text, $5::boolean, CASE WHEN $5::boolean THEN $8::text END, CASE WHEN $5::boolean THEN now() END, $6::text, $8::text, now())
     ON CONFLICT (product_id) DO UPDATE SET safety_reserve = EXCLUDED.safety_reserve, allocation_mode = EXCLUDED.allocation_mode,
       auto_sync_approved = EXCLUDED.auto_sync_approved, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now(),
       approved_by = CASE WHEN $7::boolean THEN EXCLUDED.approved_by ELSE stock_sync_groups.approved_by END,
       approved_at = CASE WHEN $7::boolean THEN EXCLUDED.approved_at ELSE stock_sync_groups.approved_at END`,
    [productId, product.adsProductId, merged.safetyReserve, merged.allocationMode, merged.autoSyncApproved, merged.notes, approvalChanged, actor],
  );
  await recordHistory(sql, { type: "group_policy_changed", actor, productId, details: patch });
  return (await getGroupPolicies(sql, [productId])).get(productId)!;
}
