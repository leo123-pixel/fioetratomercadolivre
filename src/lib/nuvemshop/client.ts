import "server-only";
import { logger, redactString } from "../logger";
import { getNuvemshopEnv, type NuvemshopEnv } from "./env";
import { assertNuvemshopWriteAllowed } from "./read-only";

/**
 * NuvemshopApiClient — Admin API 2025-03, SOMENTE LEITURA (Fase 1).
 *
 * - URL: {apiBase}/{store_id}/{recurso}; cabeçalhos Authorization: Bearer <token> e User-Agent obrigatório.
 * - Limite oficial: leaky bucket de 40 requisições com vazão de 2/s por loja × app. O cliente espaça as
 *   chamadas quando x-rate-limit-remaining fica baixo e, em 429, espera o x-rate-limit-reset (ms).
 * - Retentativas com backoff exponencial e teto só para 429, 5xx, timeout e falha de rede; nunca infinitas.
 * - 401 (token inválido/app desinstalado), 402 (loja/app sem pagamento), 403 (escopo insuficiente),
 *   404, 400 e 422 não são repetidos.
 * - Só existe caminho de sucesso para GET: qualquer outro método passa pelo portão de escrita, que recusa.
 * - O token nunca é registrado em log; URLs externas de paginação (Link) não são seguidas — a página é
 *   pedida pelo próprio cliente, sempre no host oficial e na loja selecionada.
 */
export type NuvemshopErrorKind =
  | "bad_request"
  | "unauthorized"
  | "payment_required"
  | "forbidden"
  | "not_found"
  | "unprocessable"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "invalid_response";

export class NuvemshopApiError extends Error {
  constructor(
    readonly kind: NuvemshopErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "NuvemshopApiError";
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server" || this.kind === "timeout" || this.kind === "network";
  }
}

export type WriteVerb = "POST" | "PUT" | "PATCH" | "DELETE";

export interface ClientMetrics {
  requests: number;
  retries: number;
  rateLimited: number;
  totalMs: number;
}

export interface NuvemshopClientOptions {
  storeId: string;
  accessToken: string;
  env?: Pick<NuvemshopEnv, "apiBaseUrl" | "userAgent">;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tentativas além da primeira para erros transitórios. */
  maxRetries?: number;
  timeoutMs?: number;
  retryBaseMs?: number;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  total: number | null;
  hasNext: boolean;
}

const MAX_BACKOFF_MS = 20_000;
const LOW_REMAINING = 3;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Estado do bucket por loja (por instância): espaça chamadas quando o limite está quase esgotado. */
const buckets = new Map<string, { remaining: number; resetAt: number }>();
export function resetNuvemshopThrottleForTests() {
  buckets.clear();
}

const KIND_BY_STATUS: Record<number, NuvemshopErrorKind> = {
  400: "bad_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  415: "bad_request",
  422: "unprocessable",
  429: "rate_limited",
};

const MESSAGES: Partial<Record<NuvemshopErrorKind, string>> = {
  unauthorized: "Token da Nuvemshop inválido ou revogado (aplicativo desinstalado ou reinstalado). Reconecte a loja.",
  payment_required: "A loja ou o aplicativo está com pagamento pendente na Nuvemshop: a API fica suspensa até a regularização.",
  forbidden: "Permissão insuficiente: o aplicativo não tem o escopo necessário para este recurso (reinstale após ajustar os escopos).",
  rate_limited: "Limite de requisições da Nuvemshop atingido.",
};

function numberHeader(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class NuvemshopApiClient {
  readonly storeId: string;
  readonly metrics: ClientMetrics = { requests: 0, retries: 0, rateLimited: 0, totalMs: 0 };
  private readonly token: string;
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly retryBaseMs: number;

  constructor(opts: NuvemshopClientOptions) {
    if (!/^\d{1,20}$/.test(opts.storeId)) throw new Error("store_id inválido");
    if (!opts.accessToken) throw new Error("Token ausente");
    const env = opts.env ?? getNuvemshopEnv();
    this.storeId = opts.storeId;
    this.token = opts.accessToken;
    this.apiBase = env.apiBaseUrl.replace(/\/+$/, "");
    this.userAgent = env.userAgent;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retryBaseMs = opts.retryBaseMs ?? 1_000;
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
    if (!path.startsWith("/") || path.includes("..") || /[?#\s]/.test(path)) throw new Error(`Caminho inválido: ${path}`);
    const u = new URL(`${this.apiBase}/${this.storeId}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async throttle(): Promise<void> {
    const b = buckets.get(this.storeId);
    if (b && b.remaining <= LOW_REMAINING) {
      const wait = Math.min(MAX_BACKOFF_MS, Math.max(0, b.resetAt - Date.now()), 1_500);
      if (wait > 0) await this.sleep(wait);
    }
  }

  private backoff(attempt: number, hint: number | null): number {
    const exp = Math.min(MAX_BACKOFF_MS, this.retryBaseMs * 2 ** (attempt - 1));
    return Math.min(MAX_BACKOFF_MS, Math.max(hint ?? 0, exp));
  }

  /** Uma requisição GET com retentativas limitadas. */
  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>): Promise<{ data: T; headers: Headers; status: number }> {
    const url = this.url(path, query);
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.throttle();
      const started = Date.now();
      let res: Response;
      try {
        this.metrics.requests++;
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.token}`, "User-Agent": this.userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
          cache: "no-store",
          redirect: "error",
        });
      } catch (err) {
        this.metrics.totalMs += Date.now() - started;
        const timeout = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        const e = new NuvemshopApiError(timeout ? "timeout" : "network", timeout ? "Tempo esgotado ao consultar a Nuvemshop" : "Falha de rede ao consultar a Nuvemshop");
        if (attempt <= this.maxRetries) {
          this.metrics.retries++;
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
        throw e;
      }
      this.metrics.totalMs += Date.now() - started;
      const remaining = numberHeader(res.headers, "x-rate-limit-remaining");
      const resetMs = numberHeader(res.headers, "x-rate-limit-reset");
      if (remaining !== null) buckets.set(this.storeId, { remaining, resetAt: Date.now() + (resetMs ?? 0) });

      if (res.ok) {
        const text = await res.text();
        try {
          return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers, status: res.status };
        } catch {
          throw new NuvemshopApiError("invalid_response", "Resposta da Nuvemshop não é JSON válido", res.status);
        }
      }

      const body = await res.text().catch(() => "");
      const kind: NuvemshopErrorKind = KIND_BY_STATUS[res.status] ?? (res.status >= 500 ? "server" : "bad_request");
      let detail = "";
      try {
        const j = JSON.parse(body) as { message?: string; description?: string; error?: string };
        detail = [j.message, j.description, j.error].filter(Boolean).join(" — ");
      } catch {
        detail = body.slice(0, 200);
      }
      const retryAfter = numberHeader(res.headers, "retry-after");
      const hint = kind === "rate_limited" ? (resetMs ?? (retryAfter !== null ? retryAfter * 1000 : null)) : null;
      const err = new NuvemshopApiError(kind, redactString(`${MESSAGES[kind] ?? `Nuvemshop respondeu ${res.status}`}${detail ? ` (${detail.slice(0, 300)})` : ""}`), res.status, hint);
      if (kind === "rate_limited") this.metrics.rateLimited++;
      if (err.retryable && attempt <= this.maxRetries) {
        this.metrics.retries++;
        logger.warn("Nuvemshop: nova tentativa", { status: res.status, attempt, kind });
        await this.sleep(this.backoff(attempt, hint));
        continue;
      }
      throw err;
    }
  }

  /**
   * Uma página de uma lista paginada (page começa em 1; per_page até 200). Uma página além da última
   * (a Nuvemshop responde 404 "Last page is N") é tratada como lista vazia.
   */
  async getPage<T>(path: string, page: number, perPage: number, query?: Record<string, string | number | boolean | undefined | null>): Promise<PageResult<T>> {
    if (!Number.isInteger(page) || page < 1) throw new Error("page inválida");
    const size = Math.min(200, Math.max(1, Math.trunc(perPage)));
    try {
      const { data, headers } = await this.get<T[]>(path, { ...query, page, per_page: size });
      if (!Array.isArray(data)) throw new NuvemshopApiError("invalid_response", "Lista esperada na resposta da Nuvemshop");
      const total = numberHeader(headers, "x-total-count");
      const link = headers.get("link") ?? "";
      const hasNext = /rel="next"/.test(link) || (total !== null ? page * size < total : data.length === size);
      return { items: data, page, total, hasNext: data.length > 0 && hasNext };
    } catch (err) {
      if (err instanceof NuvemshopApiError && err.kind === "not_found" && /last page/i.test(err.message)) {
        return { items: [], page, total: null, hasNext: false };
      }
      throw err;
    }
  }

  /** Fase 1: qualquer método de escrita é recusado antes de chegar à rede. */
  write(verb: WriteVerb, path: string): never {
    const method = verb;
    return assertNuvemshopWriteAllowed(`${method} ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Tipos mínimos das respostas usadas (o payload completo fica preservado em raw_payload).
// ---------------------------------------------------------------------------

export type I18n = Record<string, string> | string | null | undefined;

export interface NsStore {
  id: number | string;
  name?: I18n;
  url_with_protocol?: string | null;
  original_domain?: string | null;
  plan_name?: string | null;
  main_language?: string | null;
  main_currency?: string | null;
  country?: string | null;
  timezone_id?: string | null;
  [k: string]: unknown;
}

export interface NsInventoryLevel {
  id?: string | number;
  variant_id?: string | number;
  location_id: string;
  stock: number | null;
}

export interface NsVariant {
  id: number;
  product_id: number;
  position?: number | null;
  sku?: string | null;
  barcode?: string | null;
  mpn?: string | null;
  values?: I18n[] | null;
  price?: string | number | null;
  promotional_price?: string | number | null;
  stock_management?: boolean | null;
  stock?: number | null;
  inventory_levels?: NsInventoryLevel[] | null;
  weight?: string | number | null;
  width?: string | number | null;
  height?: string | number | null;
  depth?: string | number | null;
  visible?: boolean | null;
  image_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

export interface NsImage {
  id: number;
  product_id?: number;
  src: string;
  position?: number | null;
  alt?: I18n[] | I18n;
}

export interface NsProduct {
  id: number;
  name?: I18n;
  description?: I18n;
  handle?: I18n;
  brand?: string | null;
  visibility?: string | null;
  published?: boolean | null;
  is_kit?: boolean | null;
  attributes?: I18n[] | null;
  categories?: (number | { id: number })[] | null;
  tags?: string | null;
  canonical_url?: string | null;
  variants?: NsVariant[] | null;
  images?: NsImage[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  [k: string]: unknown;
}

export interface NsCategory {
  id: number;
  name?: I18n;
  parent?: number | null;
  [k: string]: unknown;
}

export interface NsLocation {
  id: string;
  name?: I18n;
  is_default?: boolean | null;
  priority?: number | null;
  tags?: string[] | null;
  [k: string]: unknown;
}

/** Texto no idioma principal (pt, depois qualquer um). */
export function pickText(v: I18n, lang = "pt"): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v || null;
  const keys = Object.keys(v);
  const exact = v[lang] ?? v[`${lang}_BR`] ?? keys.filter((k) => k.startsWith(lang)).map((k) => v[k])[0];
  const any = exact ?? keys.map((k) => v[k]).find((s) => typeof s === "string" && s.length > 0);
  return typeof any === "string" && any.length ? any : null;
}
