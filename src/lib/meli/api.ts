import "server-only";
import { randomUUID } from "node:crypto";
import { redactString, sanitize } from "../logger";
import { MELI_API_BASE } from "./client";
import { getValidAccessToken } from "./tokens";

/**
 * Cliente HTTP genérico da API do Mercado Livre (somente servidor).
 *
 * - Base fixa (api.mercadolibre.com): caminhos são montados pelo código, nunca vindos do navegador (sem SSRF).
 * - Token obtido por getValidAccessToken() da fase 1 (renovação com lease); nunca registrado.
 * - Erros classificados para decidir entre falha definitiva, nova tentativa segura ou resultado incerto.
 */
export type MeliErrorKind = "auth" | "forbidden" | "bad_request" | "not_found" | "rate_limited" | "server" | "timeout" | "network";

export interface MeliCause {
  code?: string;
  message?: string;
  type?: string;
  department?: string;
  references?: unknown;
}

export class MeliHttpError extends Error {
  constructor(
    readonly kind: MeliErrorKind,
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly causes: MeliCause[] = [],
    readonly retryAfterMs?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MeliHttpError";
  }

  /** O pedido certamente não foi processado? (permite repetir sem risco de duplicar) */
  get definitelyNotProcessed(): boolean {
    return this.kind === "auth" || this.kind === "forbidden" || this.kind === "bad_request" || this.kind === "not_found" || this.kind === "rate_limited";
  }
}

export interface MeliRequestOptions {
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  form?: FormData;
  /** true = exige token da conta conectada; "optional" = envia se houver conexão. */
  auth?: boolean | "optional";
  timeoutMs?: number;
}

export interface MeliResponse<T> {
  status: number;
  data: T;
  requestId: string;
  durationMs: number;
}

let minIntervalMs = 150;
let lastCall = 0;

async function throttle() {
  const wait = lastCall + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function retryAfter(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) ? s * 1000 : undefined;
}

function classify(status: number): MeliErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

export function parseCauses(body: unknown): MeliCause[] {
  const cause = (body as { cause?: unknown } | null)?.cause;
  if (!Array.isArray(cause)) return [];
  return cause.slice(0, 50).map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return {
      code: typeof o.code === "string" ? o.code : undefined,
      message: typeof o.message === "string" ? redactString(o.message).slice(0, 500) : undefined,
      type: typeof o.type === "string" ? o.type : undefined,
      department: typeof o.department === "string" ? o.department : undefined,
      references: o.references,
    };
  });
}

export async function meliRequest<T = unknown>(path: string, opts: MeliRequestOptions = {}): Promise<MeliResponse<T>> {
  if (!path.startsWith("/") || path.includes("..") || /[\s#]/.test(path)) throw new Error("Caminho inválido para a API do Mercado Livre");
  const url = new URL(path, MELI_API_BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.auth) {
    try {
      const { accessToken } = await getValidAccessToken();
      headers.authorization = `Bearer ${accessToken}`;
    } catch (err) {
      if (opts.auth === true) throw err;
    }
  }
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const requestId = randomUUID();
  await throttle();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers, body, cache: "no-store", signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
  } catch (err) {
    const name = (err as Error)?.name;
    const kind: MeliErrorKind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    throw new MeliHttpError(kind, 0, kind === "timeout" ? `Tempo esgotado em ${url.pathname}` : `Falha de rede em ${url.pathname}`);
  }
  const durationMs = Date.now() - started;
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: redactString(text.slice(0, 300)) };
    }
  }
  if (!res.ok) {
    const o = (data ?? {}) as Record<string, unknown>;
    const code = typeof o.error === "string" ? o.error : typeof o.code === "string" ? o.code : null;
    const msg = typeof o.message === "string" ? redactString(o.message).slice(0, 500) : `HTTP ${res.status}`;
    throw new MeliHttpError(classify(res.status), res.status, `${msg} (HTTP ${res.status} em ${url.pathname})`, code, parseCauses(data), retryAfter(res), sanitize(data));
  }
  return { status: res.status, data: data as T, requestId, durationMs };
}

/** Somente para testes. */
export function setMeliThrottleForTests(ms: number) {
  minIntervalMs = ms;
  lastCall = 0;
}
