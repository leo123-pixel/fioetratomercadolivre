import "server-only";
import { z } from "zod";
import { redactString } from "../logger";
import { retrySleep } from "../marketplace/errors";
import { getAdsEnv, type AdsEnv } from "./env";

export type AdsErrorKind = "auth" | "bad_request" | "not_found" | "rate_limited" | "server" | "timeout" | "network" | "invalid_response";

/** Erros que justificam nova tentativa com backoff. */
const TRANSIENT: ReadonlySet<AdsErrorKind> = new Set(["rate_limited", "server", "timeout", "network", "invalid_response"]);

export class AdsApiError extends Error {
  constructor(
    readonly kind: AdsErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AdsApiError";
  }

  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }
}

export type PagedResource = "produtos" | "tabela-precos-itens" | "estoques";
export type ListResource = "tabelas" | "fornecedores" | "divisoes";

const pageSchema = z.object({
  items: z.array(z.unknown()),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int().nonnegative(),
  hasNext: z.boolean(),
});

export type AdsPage = z.infer<typeof pageSchema>;

export interface PageRequest {
  page: number;
  pageSize?: number;
  /** Filtro por produtoId (enviado como ids=1&ids=2, formato do OpenAPI da ADS). */
  ids?: number[];
}

let lastRequestAt = 0;

/**
 * Cliente somente-leitura da ADS API. Autentica com os cabeçalhos x-api-key e User-Agent,
 * espaça as requisições (ADS_MIN_INTERVAL_MS) e classifica falhas para o mecanismo de retentativa.
 * Nunca registra nem devolve a chave da API.
 */
export class AdsClient {
  constructor(
    private readonly env: AdsEnv,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get pageSize(): number {
    return this.env.pageSize;
  }

  get retryBaseMs(): number {
    return this.env.retryBaseMs;
  }

  async getPage(resource: PagedResource, req: PageRequest): Promise<AdsPage> {
    const params = new URLSearchParams({ page: String(req.page), pageSize: String(req.pageSize ?? this.env.pageSize) });
    for (const id of req.ids ?? []) params.append("ids", String(id));
    if (resource === "estoques" && this.env.branchCnpj) params.set("cnpjfilial", this.env.branchCnpj);
    const body = await this.request(resource, params);
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) throw new AdsApiError("invalid_response", `Resposta paginada inesperada em /${resource}`);
    return parsed.data;
  }

  async getList(resource: ListResource): Promise<unknown[]> {
    const body = await this.request(resource, new URLSearchParams());
    if (!Array.isArray(body)) throw new AdsApiError("invalid_response", `Resposta inesperada em /${resource} (esperado array)`);
    return body;
  }

  private async throttle() {
    const wait = lastRequestAt + this.env.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  }

  private async request(resource: string, params: URLSearchParams): Promise<unknown> {
    await this.throttle();
    const qs = params.toString();
    const url = `${this.env.baseUrl}/api/v1/${this.env.cnpj}/${resource}${qs ? `?${qs}` : ""}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { "x-api-key": this.env.apiKey, "User-Agent": this.env.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(this.env.timeoutMs),
        cache: "no-store",
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AdsApiError("timeout", `Tempo esgotado ao consultar /${resource}`);
      }
      throw new AdsApiError("network", `Falha de rede ao consultar /${resource}`);
    }

    if (!res.ok) {
      const detail = redactString((await res.text().catch(() => "")).slice(0, 200)).replace(/\s+/g, " ");
      const suffix = detail ? `: ${detail}` : "";
      if (res.status === 401 || res.status === 403) {
        throw new AdsApiError("auth", `ADS recusou as credenciais (HTTP ${res.status}) em /${resource}`, res.status);
      }
      if (res.status === 429) {
        throw new AdsApiError("rate_limited", `Limite de requisições da ADS atingido em /${resource}`, 429, retryAfterMs(res));
      }
      if (res.status === 404) throw new AdsApiError("not_found", `/${resource} não encontrado (HTTP 404)`, 404);
      if (res.status >= 500) throw new AdsApiError("server", `Erro ${res.status} da ADS em /${resource}`, res.status, retryAfterMs(res));
      throw new AdsApiError("bad_request", `Requisição recusada pela ADS (HTTP ${res.status}) em /${resource}${suffix}`, res.status);
    }

    try {
      return await res.json();
    } catch {
      throw new AdsApiError("invalid_response", `Resposta não-JSON da ADS em /${resource}`, res.status);
    }
  }
}

export interface AdsCallResult<T = unknown> {
  status: number;
  data: T | null;
  durationMs: number;
}

/** Hosts da ADS em que é permitido ESCREVER (criar pedido/cliente) nesta fase: somente homologação. */
export const ADS_WRITE_HOSTS: ReadonlySet<string> = new Set(["hom.adsapi.com.br"]);

export class AdsWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsWriteBlockedError";
  }
}

export type AdsEnvironmentName = "homologacao" | "producao";

const flag = (name: string) => (process.env[name] ?? "").trim().toLowerCase() === "true";

/**
 * Ambiente da ADS configurado (para exibição, para separar clientes/envios/configuração e para o
 * bloqueio de escrita). Homologação: escrita permitida (salvo ADS_WRITE_DISABLED). Qualquer outro host
 * é PRODUÇÃO: escrita só com ADS_PRODUCTION_WRITE_ENABLED=true, definido conscientemente na Vercel.
 */
export function adsEnvironment(env: AdsEnv = getAdsEnv()): { host: string; environment: AdsEnvironmentName; writeAllowed: boolean } {
  const host = new URL(env.baseUrl).hostname;
  const homolog = ADS_WRITE_HOSTS.has(host);
  const disabled = flag("ADS_WRITE_DISABLED");
  const writeAllowed = !disabled && (homolog || flag("ADS_PRODUCTION_WRITE_ENABLED"));
  return { host, environment: homolog ? "homologacao" : "producao", writeAllowed };
}

/** Lança se a escrita na ADS não for permitida neste ambiente. */
export function assertAdsWriteAllowed(env: AdsEnv = getAdsEnv()): void {
  const e = adsEnvironment(env);
  if (flag("ADS_WRITE_DISABLED")) throw new AdsWriteBlockedError("Escrita na ADS desligada (ADS_WRITE_DISABLED=true)");
  if (!e.writeAllowed) throw new AdsWriteBlockedError(`Escrita na ADS de PRODUÇÃO (${e.host}) bloqueada: habilite com ADS_PRODUCTION_WRITE_ENABLED=true`);
}

let adsFetchOverride: typeof fetch | null = null;
/** Somente testes. */
export function setAdsFetchForTesting(fn: typeof fetch | null) {
  adsFetchOverride = fn;
}

/**
 * Chamada genérica à ADS (GET de cadastros/consultas e POST de pedido/cliente). Não faz retentativa:
 * quem chama decide, e um POST com resultado incerto NUNCA é repetido automaticamente.
 * 4xx/5xx retornam status e corpo (para registrar o histórico); só falhas de rede/timeout lançam.
 */
export async function adsCall<T = unknown>(
  method: "GET" | "POST",
  resource: string,
  opts: { query?: Record<string, string | number | (string | number)[] | undefined>; body?: unknown; timeoutMs?: number } = {},
): Promise<AdsCallResult<T>> {
  const env = getAdsEnv();
  if (method !== "GET") assertAdsWriteAllowed(env);
  if (!/^[a-z0-9-]+(\/[A-Za-z0-9-]+)*$/.test(resource)) throw new Error("Recurso ADS inválido");
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === "") continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, String(one));
  }
  const qs = params.toString();
  const url = `${env.baseUrl}/api/v1/${env.cnpj}/${resource}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { "x-api-key": env.apiKey, "User-Agent": env.userAgent, Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const started = Date.now();
  let res: Response;
  // Leituras (GET): no máximo 10 s cada e repetidas só quando a ADS responde RÁPIDO com indisponibilidade
  // (429/502/503/504) ou a conexão cai na hora; um tempo esgotado não é repetido (somaria minutos e
  // estouraria o limite da função). Escritas (POST) NUNCA são repetidas aqui.
  const isGet = method === "GET";
  const timeoutMs = opts.timeoutMs ?? (isGet ? Math.min(env.timeoutMs, 10_000) : env.timeoutMs);
  const maxAttempts = isGet ? 3 : 1;
  const budgetEnd = started + (isGet ? 15_000 : timeoutMs);
  for (let attempt = 1; ; attempt++) {
    try {
      res = await (adsFetchOverride ?? fetch)(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (err) {
      const name = (err as Error)?.name;
      const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      if (kind === "network" && attempt < maxAttempts && Date.now() + 1_000 < budgetEnd) {
        await retrySleep(1_000);
        continue;
      }
      throw new AdsApiError(kind, kind === "timeout" ? `ADS não respondeu em ${Math.round(timeoutMs / 1000)} s (${method} /${resource})` : `Falha de rede em ${method} /${resource}`);
    }
    const wait = Math.min(retryAfterMs(res) ?? 1_000 * attempt, 3_000);
    if (attempt < maxAttempts && [429, 502, 503, 504].includes(res.status) && Date.now() + wait < budgetEnd) {
      await res.text().catch(() => "");
      await retrySleep(wait);
      continue;
    }
    break;
  }
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: redactString(text.slice(0, 500)) };
    }
  }
  if (res.status === 401 || res.status === 403) throw new AdsApiError("auth", `ADS recusou as credenciais (HTTP ${res.status}) em /${resource}`, res.status);
  return { status: res.status, data: data as T, durationMs: Date.now() - started };
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function getAdsClient(): AdsClient {
  return new AdsClient(getAdsEnv());
}

/** Somente para testes: zera o espaçamento entre requisições. */
export function resetAdsThrottleForTests() {
  lastRequestAt = 0;
}
