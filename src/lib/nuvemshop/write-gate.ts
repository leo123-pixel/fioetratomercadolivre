import type { Sql } from "../sql";

/**
 * Portão único de escrita na Nuvemshop (Fase 2).
 *
 * Toda escrita na Admin API (POST/PUT/PATCH/DELETE) exige uma permissão (WritePermit) emitida aqui, e o
 * cliente HTTP recusa qualquer escrita sem ela. A permissão só é emitida quando TODAS as condições valem:
 *
 *   1. NUVEMSHOP_WRITE_ENABLED=true no ambiente (padrão: desligado — o deploy não liga nada sozinho);
 *   2. a loja concedeu o escopo necessário (write_products para catálogo, preço e estoque);
 *   3. o desligamento de emergência NÃO está ativo (vale para catálogo, preço e estoque).
 *
 * Os modos das automações (SHADOW/PILOT/AUTOMATIC/PAUSED) e a elegibilidade por variante são verificados
 * pelos serviços de preço e estoque ANTES de criar e de executar cada escrita; este portão é a última barreira.
 */
export type WriteCategory = "CATALOG" | "PRICE" | "STOCK" | "WEBHOOK";

export class NuvemshopWriteBlockedError extends Error {
  readonly code = "nuvemshop_write_blocked";
  constructor(
    readonly operation: string,
    readonly reason: string,
  ) {
    super(`Escrita na Nuvemshop bloqueada (${operation}): ${reason}`);
    this.name = "NuvemshopWriteBlockedError";
  }
}

export interface WriteEnvState {
  enabled: boolean;
  configured: string | null;
  warning: string | null;
}

export function nuvemshopWriteEnv(env: Record<string, string | undefined> = process.env): WriteEnvState {
  const raw = env.NUVEMSHOP_WRITE_ENABLED?.trim() ?? null;
  if (raw?.toLowerCase() === "true") return { enabled: true, configured: raw, warning: null };
  return {
    enabled: false,
    configured: raw,
    warning: raw
      ? `NUVEMSHOP_WRITE_ENABLED="${raw}" não é "true": escrita na Nuvemshop desligada`
      : "NUVEMSHOP_WRITE_ENABLED não está definida: escrita na Nuvemshop desligada (somente leitura)",
  };
}

const ISSUE = Symbol("nuvemshop-write-permit");
const PERMIT_TTL_MS = 10 * 60_000;

/** Permissão de escrita (só o portão cria). Vale para uma loja e uma categoria, por pouco tempo. */
export class WritePermit {
  readonly issuedAt = Date.now();
  constructor(
    token: symbol,
    readonly storeId: string,
    readonly category: WriteCategory,
  ) {
    if (token !== ISSUE) throw new Error("WritePermit só é emitida pelo portão de escrita");
  }
}

export function hasScope(granted: string | null | undefined, ...anyOf: string[]): boolean {
  const set = new Set((granted ?? "").split(/[\s,]+/).filter(Boolean));
  return anyOf.some((s) => set.has(s));
}

export interface EmergencyStop {
  active: boolean;
  reason: string | null;
  activatedBy: string | null;
  activatedAt: Date | null;
}

export async function getEmergencyStop(sql: Sql): Promise<EmergencyStop> {
  const [row] = await sql.query<EmergencyStop>(
    `SELECT active, reason, activated_by AS "activatedBy", activated_at AS "activatedAt" FROM nuvemshop_emergency_stop WHERE id`,
  );
  // Sem a linha (banco inconsistente): trata como PARADO por segurança.
  return row ?? { active: true, reason: "Controle de emergência ausente no banco", activatedBy: null, activatedAt: null };
}

/** Motivo de bloqueio (null = liberado), sem lançar. */
export async function writeBlockReason(sql: Sql, store: { grantedScopes: string | null }, category: WriteCategory, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const e = nuvemshopWriteEnv(env);
  if (!e.enabled) return e.warning;
  if (category !== "WEBHOOK") {
    const stop = await getEmergencyStop(sql);
    if (stop.active) return `Desligamento de emergência ativo${stop.reason ? `: ${stop.reason}` : ""}`;
    if (!hasScope(store.grantedScopes, "write_products")) return "A loja não concedeu o escopo write_products (ajuste os escopos do aplicativo e reinstale)";
  }
  return null;
}

/** Emite a permissão ou lança NuvemshopWriteBlockedError. */
export async function issueWritePermit(sql: Sql, store: { storeId: string; grantedScopes: string | null }, category: WriteCategory, operation: string): Promise<WritePermit> {
  const reason = await writeBlockReason(sql, store, category);
  if (reason) throw new NuvemshopWriteBlockedError(operation, reason);
  return new WritePermit(ISSUE, store.storeId, category);
}

/** Usado pelo cliente HTTP antes de cada escrita. */
export function assertPermit(permit: unknown, storeId: string, operation: string): asserts permit is WritePermit {
  if (!(permit instanceof WritePermit)) throw new NuvemshopWriteBlockedError(operation, "escrita sem permissão do portão");
  if (permit.storeId !== storeId) throw new NuvemshopWriteBlockedError(operation, "permissão emitida para outra loja");
  if (Date.now() - permit.issuedAt > PERMIT_TTL_MS) throw new NuvemshopWriteBlockedError(operation, "permissão expirada");
}
