import "server-only";
import { z } from "zod";
import type { Sql } from "../sql";
import { getGroupPolicies, getStockSettings } from "../stock/settings";
import { KNOWN_CHANNELS, validateRules, type AllocationPolicy, type ChannelRule } from "./allocation";
import { InventoryError } from "./mode";
import { audit } from "./ledger";

/**
 * Configuração do Inventory Core (app_settings.inventory_core_settings), políticas de alocação versionadas
 * (inventory_allocation_policies) e mapeamento de filiais ADS → depósitos (inventory_locations).
 */
export interface InventorySettings {
  /** Depósito (warehouse_code) que abastece cada canal. */
  channelWarehouses: Record<string, string>;
  /**
   * A ADS baixa/reserva o saldo já na criação do pedido? NÃO confirmado com a Tecdisa: padrão false
   * (o envio SENT não é tratado como baixa).
   */
  adsDeductsOnOrderCreated: boolean;
  /** Situações do pedido na ADS (GET /pedidos/status) que comprovam a baixa. Vazio = nenhuma comprovação automática. */
  adsReflectedStatuses: string[];
  /** Pendente sem evidência na ADS há mais que isso → REQUIRES_RECONCILIATION. */
  pendingReconcileAfterDays: number;
  /** Janela de pedidos lida para formar compromissos. */
  orderLookbackDays: number;
  /** Idade máxima do saldo ADS para o pool ser considerado confiável. */
  maxSnapshotAgeMinutes: number;
  /** Máximo de produtos consultados ao vivo na ADS por execução. */
  liveAdsMaxProducts: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  channelWarehouses: { mercadolivre: "principal", nuvemshop: "principal" },
  adsDeductsOnOrderCreated: false,
  adsReflectedStatuses: [],
  pendingReconcileAfterDays: 7,
  orderLookbackDays: 30,
  maxSnapshotAgeMinutes: 60,
  liveAdsMaxProducts: 100,
  updatedBy: null,
  updatedAt: null,
};

const KEY = "inventory_core_settings";
const WAREHOUSE_RE = /^[a-z0-9_-]{1,40}$/;

export const settingsPatchSchema = z
  .object({
    channelWarehouses: z.record(z.string().regex(/^[a-z0-9_]{2,30}$/), z.string().regex(WAREHOUSE_RE)).optional(),
    adsDeductsOnOrderCreated: z.boolean().optional(),
    adsReflectedStatuses: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
    pendingReconcileAfterDays: z.number().int().min(1).max(90).optional(),
    orderLookbackDays: z.number().int().min(1).max(120).optional(),
    maxSnapshotAgeMinutes: z.number().int().min(5).max(24 * 60).optional(),
    liveAdsMaxProducts: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export async function getInventorySettings(sql: Sql): Promise<InventorySettings> {
  const [row] = await sql.query<{ value: Partial<InventorySettings> }>(`SELECT value FROM app_settings WHERE key = $1::text`, [KEY]);
  const v = row?.value ?? {};
  return { ...DEFAULT_INVENTORY_SETTINGS, ...v, channelWarehouses: { ...DEFAULT_INVENTORY_SETTINGS.channelWarehouses, ...(v.channelWarehouses ?? {}) } };
}

export async function updateInventorySettings(sql: Sql, patch: z.infer<typeof settingsPatchSchema>, actor: string): Promise<InventorySettings> {
  return sql.transaction(async (tx) => {
    const before = await getInventorySettings(tx);
    const next: InventorySettings = {
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      channelWarehouses: { ...before.channelWarehouses, ...(patch.channelWarehouses ?? {}) },
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };
    await tx.execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1::text, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, JSON.stringify(next)],
    );
    await audit(tx, { actor, action: "settings_changed", entityType: "settings", entityId: KEY, before, after: next });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Políticas de alocação.
// ---------------------------------------------------------------------------

export interface StoredPolicy extends AllocationPolicy {
  id: string;
  scope: "GLOBAL" | "PRODUCT";
  productId: number | null;
  version: number;
  createdBy: string;
  createdAt: Date;
  notes: string | null;
}

const POLICY_COLS = `id::text AS id, scope, product_id AS "productId", version, safety_reserve AS "safetyReserve", remainder_mode AS "remainderMode",
  rules, created_by AS "createdBy", created_at AS "createdAt", notes`;

export const ruleSchema = z
  .object({
    channel: z.string().regex(/^[a-z0-9_]{2,30}$/),
    type: z.enum(["PERCENT", "FIXED", "ZERO"]),
    value: z.number().min(0).max(1_000_000).optional(),
    max: z.number().int().min(0).max(1_000_000).nullable().optional(),
    min: z.number().int().min(0).max(1_000_000).nullable().optional(),
    priority: z.number().int().min(0).max(100),
  })
  .strict();

export const policyInputSchema = z
  .object({
    productId: z.number().int().positive().nullable().optional(),
    safetyReserve: z.number().int().min(0).max(1_000_000).nullable(),
    remainderMode: z.enum(["PRIORITY", "UNALLOCATED"]).default("PRIORITY"),
    rules: z.array(ruleSchema).min(1).max(10),
    notes: z.string().max(500).nullable().optional(),
    /** Versão em que a edição se baseou (controle otimista). */
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export async function getActivePolicies(sql: Sql, productIds: number[] = []): Promise<{ global: StoredPolicy; byProduct: Map<number, StoredPolicy> }> {
  const rows = await sql.query<StoredPolicy>(
    `SELECT ${POLICY_COLS} FROM inventory_allocation_policies WHERE active AND (scope = 'GLOBAL' OR product_id = ANY($1::int[]))`,
    [productIds],
  );
  const global = rows.find((r) => r.scope === "GLOBAL");
  if (!global) throw new InventoryError("policy_missing", "Política global de alocação ausente", 500);
  return { global, byProduct: new Map(rows.filter((r) => r.scope === "PRODUCT").map((r) => [r.productId!, r])) };
}

export async function listPolicyVersions(sql: Sql, productId: number | null = null, limit = 20): Promise<StoredPolicy[]> {
  return sql.query<StoredPolicy>(
    `SELECT ${POLICY_COLS}, active FROM inventory_allocation_policies WHERE COALESCE(product_id, 0) = COALESCE($1::int, 0) ORDER BY version DESC LIMIT $2::int`,
    [productId, limit],
  );
}

/** Cria uma nova versão da política (a anterior é desativada na mesma transação). */
export async function savePolicy(sql: Sql, input: z.infer<typeof policyInputSchema>, actor: string): Promise<StoredPolicy> {
  const rules = input.rules as ChannelRule[];
  try {
    validateRules(rules);
  } catch (err) {
    throw new InventoryError("invalid_policy", err instanceof Error ? err.message : "Política inválida", 422);
  }
  for (const r of rules) if (!(KNOWN_CHANNELS as readonly string[]).includes(r.channel)) throw new InventoryError("unknown_channel", `Canal não cadastrado: ${r.channel}`, 422);
  const scope = input.productId ? "PRODUCT" : "GLOBAL";
  const productId = input.productId ?? null;
  return sql.transaction(async (tx) => {
    // Serializa edições da mesma política (várias instâncias).
    await tx.execute(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`inventory:policy:${scope}:${productId ?? 0}`]);
    const [current] = await tx.query<{ id: string; version: number }>(
      `SELECT id::text AS id, version FROM inventory_allocation_policies WHERE active AND scope = $1::text AND COALESCE(product_id, 0) = COALESCE($2::int, 0) FOR UPDATE`,
      [scope, productId],
    );
    if (input.expectedVersion !== undefined && (current?.version ?? 0) !== input.expectedVersion) {
      throw new InventoryError("policy_version_conflict", `A política mudou (versão atual ${current?.version ?? 0}); recarregue antes de salvar`, 409);
    }
    const [max] = await tx.query<{ v: number }>(
      `SELECT COALESCE(max(version), 0)::int AS v FROM inventory_allocation_policies WHERE scope = $1::text AND COALESCE(product_id, 0) = COALESCE($2::int, 0)`,
      [scope, productId],
    );
    if (current) await tx.execute(`UPDATE inventory_allocation_policies SET active = false WHERE id = $1::bigint`, [current.id]);
    const [row] = await tx.query<StoredPolicy>(
      `INSERT INTO inventory_allocation_policies (scope, product_id, version, safety_reserve, remainder_mode, rules, created_by, notes)
       VALUES ($1::text, $2::int, $3::int, $4::int, $5::text, $6::jsonb, $7::text, $8::text) RETURNING ${POLICY_COLS}`,
      [scope, productId, max.v + 1, input.safetyReserve, input.remainderMode, JSON.stringify(rules), actor, input.notes ?? null],
    );
    await audit(tx, { actor, action: "policy_saved", entityType: "policy", entityId: row.id, before: current ?? null, after: row });
    return row;
  });
}

/** Política efetiva e reserva de segurança de cada produto (herdando da sincronização atual quando NULL). */
export async function effectivePolicies(sql: Sql, productIds: number[]): Promise<Map<number, { policy: StoredPolicy; safetyReserve: number; splitMode: "EXCLUSIVE" | "SPLIT_EVEN" }>> {
  const [{ global, byProduct }, groups, stockSettings] = await Promise.all([getActivePolicies(sql, productIds), getGroupPolicies(sql, productIds), getStockSettings(sql)]);
  const out = new Map<number, { policy: StoredPolicy; safetyReserve: number; splitMode: "EXCLUSIVE" | "SPLIT_EVEN" }>();
  for (const id of productIds) {
    const policy = byProduct.get(id) ?? global;
    const group = groups.get(id);
    const safetyReserve = policy.safetyReserve ?? group?.safetyReserve ?? stockSettings.defaultSafetyReserve ?? 0;
    out.set(id, { policy, safetyReserve, splitMode: group?.allocationMode ?? "EXCLUSIVE" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filiais ADS → depósitos.
// ---------------------------------------------------------------------------

export interface LocationRow {
  branchId: string;
  warehouseCode: string;
  status: "MAPPED" | "UNMAPPED" | "EXCLUDED";
  source: string;
  notes: string | null;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

const LOCATION_COLS = `branch_id AS "branchId", warehouse_code AS "warehouseCode", status, source, notes, version, updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function listLocations(sql: Sql): Promise<LocationRow[]> {
  return sql.query<LocationRow>(`SELECT ${LOCATION_COLS} FROM inventory_locations ORDER BY branch_id`);
}

/**
 * Descobre filiais presentes no cache de estoque e as registra. Só ficam MAPPED automaticamente as filiais
 * que o administrador já escolheu na sincronização atual (stock_sync_settings.branchIds) — nenhuma outra
 * participa do cálculo sem mapeamento explícito (invariante 8).
 */
export async function discoverLocations(sql: Sql): Promise<LocationRow[]> {
  const stock = await getStockSettings(sql);
  const chosen = new Set(stock.branchIds ?? []);
  const branches = await sql.query<{ branchId: string }>(`SELECT DISTINCT branch_id AS "branchId" FROM product_stocks`);
  for (const b of new Set([...branches.map((x) => x.branchId), ...chosen])) {
    const mapped = chosen.has(b);
    await sql.execute(
      `INSERT INTO inventory_locations (branch_id, warehouse_code, status, source) VALUES ($1::text, 'principal', $2::text, $3::text)
       ON CONFLICT (branch_id) DO NOTHING`,
      [b, mapped ? "MAPPED" : "UNMAPPED", mapped ? "STOCK_SYNC_SETTINGS" : "DISCOVERED"],
    );
  }
  return listLocations(sql);
}

export const locationPatchSchema = z
  .object({
    branchId: z.string().trim().min(1).max(20),
    warehouseCode: z.string().regex(WAREHOUSE_RE),
    status: z.enum(["MAPPED", "UNMAPPED", "EXCLUDED"]),
    notes: z.string().max(300).nullable().optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export async function saveLocation(sql: Sql, input: z.infer<typeof locationPatchSchema>, actor: string): Promise<LocationRow> {
  return sql.transaction(async (tx) => {
    const [before] = await tx.query<LocationRow>(`SELECT ${LOCATION_COLS} FROM inventory_locations WHERE branch_id = $1::text FOR UPDATE`, [input.branchId]);
    if (input.expectedVersion !== undefined && (before?.version ?? 0) !== input.expectedVersion) {
      throw new InventoryError("location_version_conflict", "O mapeamento desta filial mudou; recarregue antes de salvar", 409);
    }
    const [row] = await tx.query<LocationRow>(
      `INSERT INTO inventory_locations (branch_id, warehouse_code, status, source, notes, updated_by) VALUES ($1::text, $2::text, $3::text, 'MANUAL', $4::text, $5::text)
       ON CONFLICT (branch_id) DO UPDATE SET warehouse_code = EXCLUDED.warehouse_code, status = EXCLUDED.status, source = 'MANUAL', notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by, updated_at = now(), version = inventory_locations.version + 1
       RETURNING ${LOCATION_COLS}`,
      [input.branchId, input.warehouseCode, input.status, input.notes ?? null, actor],
    );
    await audit(tx, { actor, action: "location_saved", entityType: "location", entityId: input.branchId, before: before ?? null, after: row });
    return row;
  });
}
