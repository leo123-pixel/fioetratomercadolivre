import "server-only";
import { redactString } from "../logger";
import { MeliHttpError } from "../meli/api";
import { MeliAuthError } from "../meli/tokens";

/** Erro classificado para decidir entre nova tentativa e falha definitiva. */
export interface ClassifiedError {
  code: string;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  /** Falha de autenticação (token ausente, expirado ou recusado). */
  auth: boolean;
  /** Tempo mínimo sugerido pela API (Retry-After). */
  retryAfterMs?: number;
}

/** Erro de processamento que não deve ser repetido (dado inválido, recurso de outra conta...). */
export class PermanentEventError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PermanentEventError";
  }
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof MeliHttpError) {
    const retryable = err.kind === "timeout" || err.kind === "network" || err.kind === "server" || err.kind === "rate_limited" || err.kind === "auth";
    return {
      code: err.code ? `${err.kind}:${err.code}`.slice(0, 80) : err.kind,
      message: redactString(err.message).slice(0, 1000),
      httpStatus: err.status || null,
      retryable,
      auth: err.kind === "auth",
      retryAfterMs: err.retryAfterMs,
    };
  }
  if (err instanceof MeliAuthError) {
    // Sem conexão / reautorização: tenta de novo mais tarde (o administrador pode reconectar);
    // o limite de tentativas leva o evento para FAILED, de onde pode ser reprocessado.
    return { code: `auth:${err.code}`, message: err.message, httpStatus: null, retryable: true, auth: true };
  }
  if (err instanceof PermanentEventError) return { code: err.code, message: err.message, httpStatus: null, retryable: false, auth: false };
  const message = err instanceof Error ? redactString(err.message).slice(0, 1000) : "Erro desconhecido";
  return { code: "internal_error", message, httpStatus: null, retryable: true, auth: false };
}

/** Backoff exponencial com teto e jitter: 30 s, 1 min, 2 min, 4 min... até 1 h. */
export function backoffMs(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  const jitter = Math.floor(base * 0.2 * random());
  return Math.max(base + jitter, retryAfterMs ?? 0);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sleepImpl: (ms: number) => Promise<void> = defaultSleep;

/** Somente testes: evita esperas reais nas retentativas. */
export function setRetrySleepForTesting(fn: ((ms: number) => Promise<void>) | null) {
  sleepImpl = fn ?? defaultSleep;
}

/**
 * Repete uma LEITURA no ML em falhas transitórias (timeout, rede, 5xx, 429), respeitando Retry-After.
 * Nunca usar para escrita: este módulo só lê dados do Mercado Livre.
 */
export async function withReadRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof MeliHttpError && (err.kind === "timeout" || err.kind === "network" || err.kind === "server" || err.kind === "rate_limited");
      if (!transient || i >= attempts) throw err;
      const wait = Math.min(Math.max(baseMs * 2 ** (i - 1), (err as MeliHttpError).retryAfterMs ?? 0), 10_000);
      await sleepImpl(wait);
    }
  }
}
