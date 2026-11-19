import "server-only";
import { z } from "zod";
import { audit } from "../inventory/ledger";
import type { Sql } from "../sql";

/**
 * Controle das automações Nuvemshop (preço e estoque): modos, frequência, políticas, aprovação, pausa,
 * desligamento de emergência e participação por variante.
 *
 *   DISABLED   nada roda.
 *   SHADOW     calcula e registra decisões; nenhuma escrita.
 *   PILOT      escreve SOMENTE nas variantes marcadas como PILOT.
 *   AUTOMATIC  escreve nas variantes elegíveis (PILOT/INCLUDED, ou todas as elegíveis com escopo ALL_ELIGIBLE;
 *              EXCLUDED nunca) sem confirmação por execução. Exige aprovação administrativa registrada.
 *   PAUSED     nada é escrito; "Reativar" volta ao modo anterior.
 *
 * Sair de um modo com escrita cancela as escritas ainda não iniciadas. O desligamento de emergência pausa as
 * duas automações, cancela a fila e faz o portão recusar qualquer escrita até ser liberado.
 */
export type AutomationKind = "PRICE" | "STOCK";
export type AutomationMode = "DISABLED" | "SHADOW" | "PILOT" | "AUTOMATIC" | "PAUSED";
export type Participation = "NONE" | "PILOT" | "INCLUDED" | "EXCLUDED";
export type Scope = "SELECTED" | "ALL_ELIGIBLE";

export const KINDS: AutomationKind[] = ["PRICE", "STOCK"];
export const WRITE_MODES: AutomationMode[] = ["PILOT", "AUTOMATIC"];
export const RUN_MODES: AutomationMode[] = ["SHADOW", "PILOT", "AUTOMATIC"];

export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

// ---------------------------------------------------------------------------
// Políticas
// ---------------------------------------------------------------------------

export const pricePolicySchema = z
  .object({
    /** Tabela comercial ADS de referência (ex.: "M"). Sem tabela, nada é calculado. */
    priceTableCode: z.string().trim().min(1).max(10).nullable(),
    /** Filial do preço (null = menor filial com preço ativo). */
    branchId: z.string().trim().min(1).max(10).nullable(),
    /** Margem adicional aprovada sobre o preço da tabela (%, 0 = preço da tabela). */
    marginPct: z.number().min(0).max(300),
    /** Preço mínimo (R$). Abaixo dele, o preço calculado sobe ao mínimo. */
    minPrice: z.number().min(0).max(1_000_000).nullable(),
    rounding: z.enum(["NONE", "CENTS_90", "CENTS_99", "WHOLE"]),
    /** BLOCK = não mexe em variante com preço promocional; KEEP = atualiza o preço cheio e mantém a promoção (se continuar menor). */
    promotion: z.enum(["BLOCK", "KEEP"]),
    /** Variação acima deste percentual vai para revisão manual (não é aplicada sozinha). */
    maxChangePct: z.number().min(1).max(500),
  })
  .strict();
export type PricePolicy = z.infer<typeof pricePolicySchema>;

/**
 * Tabela padrão da Nuvemshop: "F" (FIO & TRATO), definida pelo lojista — DIFERENTE da tabela do Mercado Livre
 * ("M", em app_settings.price_sync_settings). As duas configurações são independentes.
 */
export const NUVEMSHOP_DEFAULT_PRICE_TABLE = "F";

export const DEFAULT_PRICE_POLICY: PricePolicy = {
  priceTableCode: NUVEMSHOP_DEFAULT_PRICE_TABLE,
  branchId: null,
  marginPct: 0,
  minPrice: null,
  rounding: "NONE",
  promotion: "BLOCK",
  maxChangePct: 20,
};

export const stockPolicySchema = z
  .object({
    /** Momento em que um pedido Nuvemshop vira compromisso de estoque. */
    orderCommitMoment: z.enum(["CREATED", "PAID"]),
    /** Pedido sem confirmação de baixa na ADS há mais que isso bloqueia AUMENTOS nos SKUs afetados. */
    unconfirmedOrderGraceHours: z.number().int().min(1).max(24 * 30),
    /** Frequência da reconciliação de pedidos (rede de segurança dos webhooks). */
    orderReconcileMinutes: z.number().int().min(5).max(240),
    /** Máximo de escritas criadas por execução. */
    maxWritesPerRun: z.number().int().min(1).max(500),
  })
  .strict();
export type StockPolicy = z.infer<typeof stockPolicySchema>;

export const DEFAULT_STOCK_POLICY: StockPolicy = {
  orderCommitMoment: "CREATED",
  unconfirmedOrderGraceHours: 48,
  orderReconcileMinutes: 10,
  maxWritesPerRun: 100,
};

export interface AutomationSettings<P = PricePolicy | StockPolicy> {
  kind: AutomationKind;
  mode: AutomationMode;
  resumeMode: AutomationMode | null;
  scope: Scope;
  intervalMinutes: number;
  policy: P;
  automaticApprovedBy: string | null;
  automaticApprovedAt: Date | null;
  pausedReason: string | null;
  lastRunId: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

const COLS = `kind, mode, resume_mode AS "resumeMode", scope, interval_minutes AS "intervalMinutes", policy, automatic_approved_by AS "automaticApprovedBy",
  automatic_approved_at AS "automaticApprovedAt", paused_reason AS "pausedReason", last_run_id::text AS "lastRunId", last_run_at AS "lastRunAt",
  next_run_at AS "nextRunAt", version, updated_by AS "updatedBy", updated_at AS "updatedAt"`;

function withPolicy(row: AutomationSettings<Record<string, unknown>>): AutomationSettings {
  const policy = row.kind === "PRICE" ? { ...DEFAULT_PRICE_POLICY, ...(row.policy ?? {}) } : { ...DEFAULT_STOCK_POLICY, ...(row.policy ?? {}) };
  return { ...row, policy } as AutomationSettings;
}

export async function getAutomation(sql: Sql, kind: "PRICE"): Promise<AutomationSettings<PricePolicy>>;
export async function getAutomation(sql: Sql, kind: "STOCK"): Promise<AutomationSettings<StockPolicy>>;
export async function getAutomation(sql: Sql, kind: AutomationKind): Promise<AutomationSettings>;
export async function getAutomation(sql: Sql, kind: AutomationKind): Promise<AutomationSettings> {
  const [row] = await sql.query<AutomationSettings<Record<string, unknown>>>(`SELECT ${COLS} FROM nuvemshop_automation_settings WHERE kind = $1`, [kind]);
  if (!row) throw new AutomationError("automation_missing", `Configuração da automação ${kind} ausente`, 500);
  return withPolicy(row);
}

export async function listAutomations(sql: Sql): Promise<AutomationSettings[]> {
  const rows = await sql.query<AutomationSettings<Record<string, unknown>>>(`SELECT ${COLS} FROM nuvemshop_automation_settings ORDER BY kind`);
  return rows.map(withPolicy);
}

export const settingsPatchSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    intervalMinutes: z.number().int().min(5).max(1440).optional(),
    scope: z.enum(["SELECTED", "ALL_ELIGIBLE"]).optional(),
    policy: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Altera frequência, escopo e política (com controle de versão otimista). */
export async function updateAutomationSettings(sql: Sql, kind: AutomationKind, patch: z.infer<typeof settingsPatchSchema>, actor: string): Promise<AutomationSettings> {
  return sql.transaction(async (tx) => {
    const current = await getAutomation(tx, kind);
    if (current.version !== patch.expectedVersion) throw new AutomationError("version_conflict", "A configuração foi alterada por outra pessoa. Recarregue a página.");
    let policy = current.policy as Record<string, unknown>;
    if (patch.policy) {
      const merged = { ...policy, ...patch.policy };
      const parsed = kind === "PRICE" ? pricePolicySchema.safeParse(merged) : stockPolicySchema.safeParse(merged);
      if (!parsed.success) throw new AutomationError("invalid_policy", "Política inválida", 422, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      policy = parsed.data as Record<string, unknown>;
    }
    if (patch.scope === "ALL_ELIGIBLE" && current.mode === "AUTOMATIC" && current.scope !== "ALL_ELIGIBLE") {
      throw new AutomationError("scope_requires_reapproval", "Ampliar o escopo para todas as variantes elegíveis exige pausar e reaprovar o modo automático");
    }
    const interval = patch.intervalMinutes ?? current.intervalMinutes;
    await tx.execute(
      `UPDATE nuvemshop_automation_settings SET interval_minutes = $2, scope = $3, policy = $4::jsonb, version = version + 1, updated_by = $5, updated_at = now(),
         next_run_at = CASE WHEN last_run_at IS NULL THEN next_run_at ELSE last_run_at + make_interval(mins => $2::int) END
       WHERE kind = $1 AND version = $6`,
      [kind, interval, patch.scope ?? current.scope, JSON.stringify(policy), actor, patch.expectedVersion],
    );
    await audit(tx, { actor, action: "NS_AUTOMATION_SETTINGS", entityType: "nuvemshop_automation", entityId: kind, before: { interval: current.intervalMinutes, scope: current.scope, policy: current.policy }, after: { interval, scope: patch.scope ?? current.scope, policy } });
    return getAutomation(tx, kind);
  });
}

/** Frase exigida para aprovar o modo automático (confirmação explícita no painel). */
export const AUTOMATIC_CONFIRMATION = "ATIVAR AUTOMÁTICO";

export interface ModeChange {
  mode: Exclude<AutomationMode, "PAUSED">;
  confirmation?: string | null;
  reason?: string | null;
}

/**
 * Troca de modo. Ativar AUTOMATIC exige a frase de confirmação e registra a aprovação. Pré-condições
 * específicas (ex.: proteção de pedidos para o estoque) são verificadas por `preconditions` antes de gravar.
 */
export async function setAutomationMode(
  sql: Sql,
  kind: AutomationKind,
  change: ModeChange,
  actor: string,
  preconditions: (mode: AutomationMode) => Promise<string[]> = async () => [],
): Promise<AutomationSettings> {
  if (WRITE_MODES.includes(change.mode)) {
    const blockers = await preconditions(change.mode);
    if (blockers.length) throw new AutomationError("activation_blocked", `Não é possível ativar ${change.mode}: ${blockers.join("; ")}`, 409, { blockers });
  }
  if (change.mode === "AUTOMATIC" && change.confirmation?.trim().toUpperCase() !== AUTOMATIC_CONFIRMATION) {
    throw new AutomationError("confirmation_required", `Para ativar o modo automático digite "${AUTOMATIC_CONFIRMATION}"`, 422);
  }
  return sql.transaction(async (tx) => {
    const [stop] = await tx.query<{ active: boolean }>(`SELECT active FROM nuvemshop_emergency_stop WHERE id FOR UPDATE`);
    if (stop?.active && change.mode !== "DISABLED" && change.mode !== "SHADOW") throw new AutomationError("emergency_stop_active", "Desligamento de emergência ativo: libere-o antes de ativar escritas");
    const current = await getAutomation(tx, kind);
    const approve = change.mode === "AUTOMATIC";
    await tx.execute(
      `UPDATE nuvemshop_automation_settings SET mode = $2, resume_mode = NULL, paused_reason = NULL,
         automatic_approved_by = CASE WHEN $3::boolean THEN $4 WHEN $2 = 'AUTOMATIC' THEN automatic_approved_by ELSE NULL END,
         automatic_approved_at = CASE WHEN $3::boolean THEN now() WHEN $2 = 'AUTOMATIC' THEN automatic_approved_at ELSE NULL END,
         next_run_at = COALESCE(next_run_at, now()), version = version + 1, updated_by = $4, updated_at = now()
       WHERE kind = $1`,
      [kind, change.mode, approve, actor],
    );
    if (!WRITE_MODES.includes(change.mode)) await cancelPendingJobs(tx, kind, `Automação ${kind} alterada para ${change.mode}`);
    await audit(tx, { actor, action: "NS_AUTOMATION_MODE", entityType: "nuvemshop_automation", entityId: kind, before: { mode: current.mode }, after: { mode: change.mode, reason: change.reason ?? null, approved: approve } });
    return getAutomation(tx, kind);
  });
}

export async function pauseAutomation(sql: Sql, kind: AutomationKind, actor: string, reason: string): Promise<AutomationSettings> {
  return sql.transaction(async (tx) => {
    const current = await getAutomation(tx, kind);
    if (current.mode === "PAUSED" || current.mode === "DISABLED") return current;
    await tx.execute(
      `UPDATE nuvemshop_automation_settings SET mode = 'PAUSED', resume_mode = $2, paused_reason = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE kind = $1`,
      [kind, current.mode, reason.slice(0, 300), actor],
    );
    await cancelPendingJobs(tx, kind, `Automação ${kind} pausada: ${reason}`);
    await audit(tx, { actor, action: "NS_AUTOMATION_PAUSE", entityType: "nuvemshop_automation", entityId: kind, before: { mode: current.mode }, after: { mode: "PAUSED", reason } });
    return getAutomation(tx, kind);
  });
}

export async function resumeAutomation(sql: Sql, kind: AutomationKind, actor: string, preconditions: (mode: AutomationMode) => Promise<string[]> = async () => []): Promise<AutomationSettings> {
  const current = await getAutomation(sql, kind);
  if (current.mode !== "PAUSED" || !current.resumeMode) throw new AutomationError("not_paused", "A automação não está pausada");
  const target = current.resumeMode;
  if (WRITE_MODES.includes(target)) {
    const blockers = await preconditions(target);
    if (blockers.length) throw new AutomationError("activation_blocked", `Não é possível reativar ${target}: ${blockers.join("; ")}`, 409, { blockers });
  }
  return sql.transaction(async (tx) => {
    const [stop] = await tx.query<{ active: boolean }>(`SELECT active FROM nuvemshop_emergency_stop WHERE id FOR UPDATE`);
    if (stop?.active && WRITE_MODES.includes(target)) throw new AutomationError("emergency_stop_active", "Desligamento de emergência ativo: libere-o antes de reativar");
    // AUTOMATIC reativado mantém a aprovação original (a pausa não a revoga).
    const n = await tx.execute(
      `UPDATE nuvemshop_automation_settings SET mode = resume_mode, resume_mode = NULL, paused_reason = NULL, next_run_at = now(), version = version + 1, updated_by = $2, updated_at = now()
       WHERE kind = $1 AND mode = 'PAUSED' AND resume_mode IS NOT NULL AND (resume_mode <> 'AUTOMATIC' OR automatic_approved_at IS NOT NULL)`,
      [kind, actor],
    );
    if (n !== 1) throw new AutomationError("resume_failed", "Não foi possível reativar (aprovação do modo automático ausente)");
    await audit(tx, { actor, action: "NS_AUTOMATION_RESUME", entityType: "nuvemshop_automation", entityId: kind, before: { mode: "PAUSED" }, after: { mode: target } });
    return getAutomation(tx, kind);
  });
}

/** Cancela escritas ainda não iniciadas (PENDING). Escritas em andamento terminam e são conferidas. */
export async function cancelPendingJobs(sql: Sql, kind: AutomationKind | null, reason: string): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE nuvemshop_write_jobs SET status = 'CANCELED', error_code = 'CANCELED', error_message = $2, finished_at = now(), updated_at = now()
     WHERE status = 'PENDING' AND ($1::text IS NULL OR kind = $1) RETURNING id::text AS id`,
    [kind, reason.slice(0, 300)],
  );
  for (const r of rows) {
    await sql.execute(`INSERT INTO nuvemshop_write_attempts (job_id, attempt, outcome, message) VALUES ($1::uuid, 0, 'CANCELED', $2)`, [r.id, reason.slice(0, 300)]);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Desligamento de emergência
// ---------------------------------------------------------------------------

export async function activateEmergencyStop(sql: Sql, actor: string, reason: string): Promise<{ canceled: number }> {
  return sql.transaction(async (tx) => {
    await tx.execute(
      `UPDATE nuvemshop_emergency_stop SET active = true, reason = $1, activated_by = $2, activated_at = now(), released_by = NULL, released_at = NULL, updated_at = now() WHERE id`,
      [reason.slice(0, 300), actor],
    );
    for (const kind of KINDS) {
      const current = await getAutomation(tx, kind);
      if (current.mode !== "PAUSED" && current.mode !== "DISABLED") {
        await tx.execute(
          `UPDATE nuvemshop_automation_settings SET mode = 'PAUSED', resume_mode = $2, paused_reason = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE kind = $1`,
          [kind, current.mode, `Desligamento de emergência: ${reason}`.slice(0, 300), actor],
        );
      }
    }
    const canceled = await cancelPendingJobs(tx, null, `Desligamento de emergência: ${reason}`);
    await audit(tx, { actor, action: "NS_EMERGENCY_STOP", entityType: "nuvemshop_automation", entityId: "ALL", after: { reason, canceled } });
    return { canceled };
  });
}

export async function releaseEmergencyStop(sql: Sql, actor: string): Promise<void> {
  await sql.transaction(async (tx) => {
    await tx.execute(`UPDATE nuvemshop_emergency_stop SET active = false, released_by = $1, released_at = now(), updated_at = now() WHERE id`, [actor]);
    await audit(tx, { actor, action: "NS_EMERGENCY_RELEASE", entityType: "nuvemshop_automation", entityId: "ALL", after: { note: "Automações continuam pausadas até serem reativadas" } });
  });
}

// ---------------------------------------------------------------------------
// Participação por variante
// ---------------------------------------------------------------------------

/** A variante pode receber escrita neste modo? (elegibilidade técnica é verificada à parte). */
export function selectedForWrite(mode: AutomationMode, scope: Scope, participation: Participation): boolean {
  if (participation === "EXCLUDED") return false;
  if (mode === "PILOT") return participation === "PILOT";
  if (mode === "AUTOMATIC") return scope === "ALL_ELIGIBLE" || participation === "PILOT" || participation === "INCLUDED";
  return false;
}

export async function setParticipation(sql: Sql, input: { storeId: string; kind: AutomationKind; variantIds: string[]; participation: Participation; actor: string }): Promise<number> {
  const ids = [...new Set(input.variantIds.filter((v) => /^\d{1,20}$/.test(v)))].slice(0, 500);
  if (!ids.length) return 0;
  return sql.transaction(async (tx) => {
    const known = await tx.query<{ variantId: string }>(
      `SELECT variant_id::text AS "variantId" FROM nuvemshop_variants WHERE store_id = $1 AND variant_id = ANY($2::bigint[])`,
      [input.storeId, ids],
    );
    if (known.length !== ids.length) throw new AutomationError("unknown_variant", "Variante inexistente no catálogo importado", 422);
    for (const id of ids) {
      await tx.execute(
        `INSERT INTO nuvemshop_sync_variants (store_id, variant_id, kind, participation, participation_by, participation_at) VALUES ($1, $2::bigint, $3, $4, $5, now())
         ON CONFLICT (store_id, variant_id, kind) DO UPDATE SET participation = EXCLUDED.participation, participation_by = EXCLUDED.participation_by,
           participation_at = now(), updated_at = now()`,
        [input.storeId, id, input.kind, input.participation, input.actor],
      );
    }
    if (input.participation === "EXCLUDED" || input.participation === "NONE") {
      await tx.execute(
        `UPDATE nuvemshop_write_jobs SET status = 'CANCELED', error_code = 'CANCELED', error_message = 'Variante retirada da automação', finished_at = now(), updated_at = now()
         WHERE status = 'PENDING' AND kind = $1 AND store_id = $2 AND variant_id = ANY($3::bigint[]) AND mode <> 'MANUAL'`,
        [input.kind, input.storeId, ids],
      );
    }
    await audit(tx, { actor: input.actor, action: "NS_PARTICIPATION", entityType: "nuvemshop_automation", entityId: input.kind, after: { variantIds: ids, participation: input.participation } });
    return ids.length;
  });
}

/** Marca o resultado da avaliação de uma variante (estado exibido no painel). */
export async function recordVariantDecision(
  sql: Sql,
  input: { storeId: string; variantId: string; kind: AutomationKind; decision: string; reasonCode: string | null; reason: string | null; target: string | null; remote: string | null },
): Promise<void> {
  await sql.execute(
    `INSERT INTO nuvemshop_sync_variants (store_id, variant_id, kind, last_decision, last_reason_code, last_reason, last_target, last_remote_value, evaluated_at, dirty_at)
     VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, now(), NULL)
     ON CONFLICT (store_id, variant_id, kind) DO UPDATE SET last_decision = EXCLUDED.last_decision, last_reason_code = EXCLUDED.last_reason_code,
       last_reason = EXCLUDED.last_reason, last_target = EXCLUDED.last_target, last_remote_value = EXCLUDED.last_remote_value, evaluated_at = now(), dirty_at = NULL, updated_at = now()`,
    [input.storeId, input.variantId, input.kind, input.decision, input.reasonCode, input.reason?.slice(0, 300) ?? null, input.target, input.remote],
  );
}

export async function markRunScheduled(sql: Sql, kind: AutomationKind, runId: string, intervalMinutes: number): Promise<void> {
  await sql.execute(
    `UPDATE nuvemshop_automation_settings SET last_run_id = $2::uuid, last_run_at = now(), next_run_at = now() + make_interval(mins => $3::int) WHERE kind = $1`,
    [kind, runId, intervalMinutes],
  );
}

export async function isRunDue(sql: Sql, kind: AutomationKind): Promise<boolean> {
  const [row] = await sql.query<{ due: boolean }>(
    `SELECT (mode IN ('SHADOW', 'PILOT', 'AUTOMATIC') AND (next_run_at IS NULL OR next_run_at <= now() + interval '15 seconds')) AS due FROM nuvemshop_automation_settings WHERE kind = $1`,
    [kind],
  );
  return row?.due === true;
}
