import { vi } from "vitest";

/**
 * Servidor ADS simulado (fetch stub). Reproduz o formato real: rotas /api/v1/{cnpj}/..., cabeçalhos
 * x-api-key + User-Agent, paginação { items, page, pageSize, total, hasNext } e filtro ids=1&ids=2.
 */
export const ADS_BASE = "https://ads.test";
export const ADS_CNPJ = "12345678000190";
export const ADS_KEY = "test-ads-key-NAO-REAL";
export const ADS_UA = "FioTrato-Integrador-Teste";

export interface AdsData {
  products: Record<string, unknown>[];
  prices: Record<string, unknown>[];
  stocks: Record<string, unknown>[];
  tables: Record<string, unknown>[];
  suppliers: Record<string, unknown>[];
  divisions: Record<string, unknown>[];
}

export interface Failure {
  resource: string;
  page?: number;
  /** Quantas vezes falhar (Infinity = sempre). */
  times: number;
  status?: number;
  kind?: "timeout" | "network";
  retryAfter?: string;
}

export interface AdsCall {
  resource: string;
  page: number | null;
  pageSize: number | null;
  ids: number[];
  headers: Record<string, string>;
}

export function product(id: number, overrides: Record<string, unknown> = {}) {
  return {
    produtoId: id,
    fornecId: 547,
    divisaoId: "052",
    codFab: `H${String(id).padStart(7, "0")}`,
    dun14: "",
    ean13: `789601410${String(id).padStart(4, "0")}`,
    ncm: "33059000",
    descricao: `PRODUTO TESTE ${id}`,
    apresentacao: "950ML",
    unidade: "UN",
    qtdEmb: 1,
    largura: 0,
    altura: 0,
    comprimento: 0,
    pesoBruto: 1.053,
    pesoLiquido: 1.053,
    inativo: false,
    imagem: null,
    b2B: true,
    descricaoComplementar: "",
    medicamento: false,
    kit: false,
    ...overrides,
  };
}

export function price(produtoId: number, tabelaPreco: string, preco: number | null, overrides: Record<string, unknown> = {}) {
  return {
    filialId: "01",
    tabelaPreco,
    produtoId,
    preco,
    desconto: 10,
    comissao: 8,
    cTeto: 72.1467,
    dc: true,
    bdf: true,
    ae: true,
    inativo: false,
    promocao: false,
    pvs: 83.25,
    quantidadeMinima: 0,
    dataHora: "2026-10-30T10:00:00",
    ...overrides,
  };
}

export function stock(produtoId: number, estoque: number, overrides: Record<string, unknown> = {}) {
  return { filialId: "01", produtoId, estoque, ultVnd: "2026-10-22T00:00:00", ...overrides };
}

export function table(codigo: string, descricao: string, overrides: Record<string, unknown> = {}) {
  return {
    codigo,
    descricao,
    base: "C",
    despesa: 0,
    comissao: 0,
    lucro: 0,
    frete: 0,
    majoracao: 0,
    normal: codigo === "G",
    inativo: false,
    dataHora: "2026-10-01T08:00:00",
    ...overrides,
  };
}

export function defaultData(): AdsData {
  return {
    products: [],
    prices: [],
    stocks: [],
    tables: [table("F", "FIO & TRATO"), table("G", "Geral"), table("U", "B2B")],
    suppliers: [{ fornecId: 547, nome: "LOREAL BRASIL", fantasia: "LOREAL", inativo: false, cnpjCpf: "00000000000000" }],
    divisions: [{ codigo: "052", descricao: "COLORACAO", inativo: false }],
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function mockAds(data: AdsData, failures: Failure[] = []) {
  const calls: AdsCall[] = [];
  const remaining = failures.map((f) => ({ ...f }));

  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== ADS_BASE) throw new Error(`Chamada inesperada: ${url.origin}`);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const match = url.pathname.match(/^\/api\/v1\/(\d+)\/([a-z-]+)$/);
    const resource = match?.[2] ?? "";
    const page = url.searchParams.get("page") ? Number(url.searchParams.get("page")) : null;
    const pageSize = url.searchParams.get("pageSize") ? Number(url.searchParams.get("pageSize")) : null;
    const ids = url.searchParams.getAll("ids").map(Number);
    calls.push({ resource, page, pageSize, ids, headers });

    if (headers["x-api-key"] !== ADS_KEY || headers["user-agent"] !== ADS_UA) return json({ title: "Unauthorized" }, 401);
    if (match?.[1] !== ADS_CNPJ) return json({ title: "CNPJ inválido" }, 400);

    const failure = remaining.find((f) => f.resource === resource && (f.page === undefined || f.page === page) && f.times > 0);
    if (failure) {
      failure.times -= 1;
      if (failure.kind === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (failure.kind === "network") throw new TypeError("fetch failed");
      return json({ title: "erro simulado" }, failure.status ?? 500, failure.retryAfter ? { "retry-after": failure.retryAfter } : {});
    }

    const lists: Record<string, unknown[]> = { tabelas: data.tables, fornecedores: data.suppliers, divisoes: data.divisions };
    if (resource in lists) return json(lists[resource]);

    const source: Record<string, Record<string, unknown>[]> = {
      produtos: data.products,
      "tabela-precos-itens": data.prices,
      estoques: data.stocks,
    };
    const all = source[resource];
    if (!all) return json({ title: "Not found" }, 404);
    const filtered = ids.length ? all.filter((i) => ids.includes(i.produtoId as number)) : all;
    const p = page ?? 1;
    const size = pageSize ?? 50;
    const items = filtered.slice((p - 1) * size, p * size);
    return json({ items, page: p, pageSize: size, total: filtered.length, hasNext: p * size < filtered.length });
  });

  vi.stubGlobal("fetch", handler);
  return { calls, handler };
}
