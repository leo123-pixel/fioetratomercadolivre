import { vi } from "vitest";
import { ADS_BASE, ADS_CNPJ, ADS_KEY } from "./ads-mock";

/**
 * Mercado Livre + ADS simulados para a vinculação de anúncios legados e a sincronização de estoque.
 * Reproduz: busca paginada da conta, multiget, PUT de quantidade (pausa por falta de estoque em 0 e
 * reativação do pausado por falta de estoque), variações (omitir uma variação no PUT = erro), User Products
 * com estoque replicado entre anúncios e estoque distribuído (x-version, 409 em versão antiga).
 */
export const SELLER = "42";

export interface MockItem {
  id: string;
  title?: string;
  status?: string;
  sub_status?: string[];
  available_quantity?: number;
  user_product_id?: string | null;
  seller_custom_field?: string | null;
  attributes?: { id: string; value_name: string }[];
  variations?: { id: number; available_quantity: number; attribute_combinations?: { name: string; value_name: string }[]; attributes?: { id: string; value_name: string }[] }[];
  shipping?: { logistic_type: string };
  seller_id?: number;
}

export type PutMode = "ok" | "ignore" | "500" | "500_applied" | "timeout_applied" | "400" | "409_external";

export interface StockMockState {
  items: Map<string, MockItem>;
  upStock: Map<string, { locations: { type: string; quantity: number; store_id?: string }[]; version: number }>;
  putModes: PutMode[];
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
  ads: { produtoId: number; filialId: string; estoque: number }[];
  adsFail: boolean;
  tags: string[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function item(id: string, o: Partial<MockItem> = {}): MockItem {
  return { id, title: `Anúncio ${id}`, status: "active", sub_status: [], available_quantity: 10, user_product_id: null, attributes: [], seller_id: 42, ...o };
}

function setQty(it: MockItem, q: number) {
  it.available_quantity = q;
  if (q === 0 && it.status === "active") {
    it.status = "paused";
    it.sub_status = ["out_of_stock"];
  } else if (q > 0 && it.status === "paused" && it.sub_status?.includes("out_of_stock")) {
    it.status = "active";
    it.sub_status = [];
  }
}

export function mockStock(init: Partial<StockMockState> = {}) {
  const state: StockMockState = { items: new Map(), upStock: new Map(), putModes: [], calls: [], ads: [], adsFail: false, tags: ["normal", "user_product_seller"], ...init };

  const applyPut = (path: string, body: Record<string, unknown>, headers: Record<string, string>): Response => {
    const up = path.match(/^\/user-products\/([^/]+)\/stock\/type\/selling_address$/);
    if (up) {
      const s = state.upStock.get(decodeURIComponent(up[1]));
      if (!s) return json({ message: "not found" }, 404);
      if (!headers["x-version"]) return json({ message: "x-version required" }, 400);
      if (Number(headers["x-version"]) !== s.version) return json({ message: "version conflict" }, 409);
      const loc = s.locations.find((l) => l.type === "selling_address")!;
      loc.quantity = Number(body.quantity);
      s.version++;
      const total = s.locations.reduce((a, l) => a + l.quantity, 0);
      for (const it of state.items.values()) if (it.user_product_id === decodeURIComponent(up[1])) setQty(it, total);
      return json({ ok: true });
    }
    const m = path.match(/^\/items\/(MLB\d+)$/);
    const it = m && state.items.get(m[1]);
    if (!it) return json({ message: "not found" }, 404);
    if (Array.isArray(body.variations)) {
      const sent = (body.variations as { id: number; available_quantity?: number }[]).map((v) => v.id);
      if ((it.variations ?? []).some((v) => !sent.includes(v.id))) return json({ message: "variação omitida seria excluída" }, 400);
      for (const v of body.variations as { id: number; available_quantity?: number }[]) {
        const target = it.variations!.find((x) => x.id === v.id);
        if (target && v.available_quantity !== undefined) target.available_quantity = v.available_quantity;
      }
      return json({ id: it.id });
    }
    if (Object.keys(body).some((k) => k !== "available_quantity")) return json({ message: "campo não permitido no teste" }, 400);
    const q = Number(body.available_quantity);
    if (it.user_product_id && !state.upStock.has(it.user_product_id)) {
      // Sem estoque distribuído, o ML replica a quantidade entre os anúncios do mesmo User Product.
      for (const other of state.items.values()) if (other.user_product_id === it.user_product_id) setQty(other, q);
    } else setQty(it, q);
    return json({ id: it.id, available_quantity: it.available_quantity });
  };

  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);

    if (url.origin === ADS_BASE) {
      if (headers["x-api-key"] !== ADS_KEY) return json({ title: "Unauthorized" }, 401);
      if (!url.pathname.startsWith(`/api/v1/${ADS_CNPJ}/estoques`)) return json({ title: "not found" }, 404);
      if (state.adsFail) return json({ title: "erro simulado" }, 500);
      const ids = url.searchParams.getAll("ids").map(Number);
      const rows = state.ads.filter((s) => ids.includes(s.produtoId));
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("pageSize") ?? 50);
      return json({ items: rows.slice((page - 1) * size, page * size), page, pageSize: size, total: rows.length, hasNext: page * size < rows.length });
    }
    if (url.origin !== "https://api.mercadolibre.com") throw new Error(`Chamada inesperada: ${url.href}`);
    const path = url.pathname;
    state.calls.push({ method, path: path + url.search, body, headers });
    if (!headers.authorization?.startsWith("Bearer ")) return json({ message: "unauthorized" }, 401);

    if (method === "GET" && path === "/users/me") return json({ id: 42, nickname: "FIOETRATO", site_id: "MLB", tags: state.tags });
    if (method === "GET" && path === `/users/${SELLER}/items/search`) {
      const all = [...state.items.keys()];
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ seller_id: SELLER, results: all.slice(offset, offset + limit), paging: { total: all.length, offset, limit } });
    }
    if (method === "GET" && path === "/items" && url.searchParams.get("ids")) {
      const ids = url.searchParams.get("ids")!.split(",");
      if (ids.length > 20) return json({ message: "máximo 20 ids" }, 400);
      return json(ids.map((id) => (state.items.has(id) ? { code: 200, body: structuredClone(state.items.get(id)) } : { code: 404, body: { message: "not found" } })));
    }
    const itemGet = path.match(/^\/items\/(MLB\d+)$/);
    if (method === "GET" && itemGet) return state.items.has(itemGet[1]) ? json(state.items.get(itemGet[1])) : json({ message: "not found" }, 404);
    const upGet = path.match(/^\/user-products\/([^/]+)\/stock$/);
    if (method === "GET" && upGet) {
      const s = state.upStock.get(decodeURIComponent(upGet[1]));
      return s ? json({ id: upGet[1], user_id: 42, locations: s.locations }, 200, { "x-version": String(s.version) }) : json({ message: "not found" }, 404);
    }
    if (method === "PUT") {
      const mode = state.putModes.shift() ?? "ok";
      const b = (body ?? {}) as Record<string, unknown>;
      switch (mode) {
        case "ignore":
          return json({ ok: true });
        case "500":
          return json({ message: "internal error" }, 500);
        case "500_applied":
          applyPut(path, b, headers);
          return json({ message: "internal error" }, 500);
        case "timeout_applied":
          applyPut(path, b, headers);
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        case "400":
          return json({ message: "Validation error", error: "validation_error", cause: [] }, 400);
        case "409_external": {
          // Outra escrita mudou o estoque antes da nossa: a versão enviada fica velha.
          const up = path.match(/^\/user-products\/([^/]+)\//);
          const s = up && state.upStock.get(decodeURIComponent(up[1]));
          if (s) s.version++;
          return applyPut(path, b, headers);
        }
        default:
          return applyPut(path, b, headers);
      }
    }
    return json({ message: `não simulado: ${method} ${path}` }, 599);
  });
  vi.stubGlobal("fetch", handler);
  const puts = () => state.calls.filter((c) => c.method === "PUT");
  return { state, handler, puts };
}
