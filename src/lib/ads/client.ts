import "server-only";
import { z } from "zod";
import { redactString } from "../logger";
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
