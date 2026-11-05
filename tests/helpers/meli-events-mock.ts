import { vi } from "vitest";

/**
 * Mercado Livre simulado para as fases 4/5 (somente LEITURA): itens, busca de itens do vendedor,
 * user products, pedidos, envios e missed_feeds. Qualquer chamada que não seja GET falha o teste,
 * e chamadas a outros hosts (ex.: ADS) também.
 */
export const SELLER = "42";
export const APP_ID = "1234567890";

export type Failure = "500" | "429" | "401" | "403" | "timeout";

export interface EventsMockState {
  items: Map<string, Record<string, unknown>>;
  orders: Map<string, Record<string, unknown>>;
  shipments: Map<string, Record<string, unknown>>;
  userProducts: Map<string, Record<string, unknown>>;
  missedFeeds: Record<string, Record<string, unknown>[]>;
  /** Falhas programadas por prefixo de caminho (consumidas na ordem). */
  failures: { prefix: string; kind: Failure }[];
  calls: { method: string; path: string; query: string }[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function item(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    seller_id: Number(SELLER),
    status: "active",
    sub_status: [],
    price: 99.9,
    available_quantity: 3,
    title: `Produto ${id}`,
    category_id: "MLB264861",
    permalink: `https://produto.mercadolivre.com.br/${id}`,
    last_updated: "2026-11-05T10:00:00.000Z",
    attributes: [{ id: "SELLER_SKU", value_name: "ADS-1804" }],
    ...over,
  };
}

export function mockMeliEvents(over: Partial<EventsMockState> = {}) {
  const state: EventsMockState = {
    items: new Map(),
    orders: new Map(),
    shipments: new Map(),
    userProducts: new Map(),
    missedFeeds: {},
    failures: [],
    calls: [],
    ...over,
  };
  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.origin !== "https://api.mercadolibre.com") throw new Error(`Chamada inesperada: ${url.href}`);
    const path = url.pathname;
    state.calls.push({ method, path, query: url.search });
    if (method !== "GET") throw new Error(`Escrita inesperada no ML: ${method} ${path}`);
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth?.startsWith("Bearer ")) return json({ message: "invalid access token", status: 401 }, 401);

    const fi = state.failures.findIndex((f) => path.startsWith(f.prefix));
    if (fi >= 0) {
      const [f] = state.failures.splice(fi, 1);
      if (f.kind === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      const status = Number(f.kind);
      return json({ message: `falha simulada ${status}`, error: status === 429 ? "too_many_requests" : "error", status }, status, status === 429 ? { "retry-after": "1" } : {});
    }

    if (path === "/items" && url.searchParams.get("ids")) {
      const ids = url.searchParams.get("ids")!.split(",");
      if (ids.length > 20) return json({ message: "max 20 ids" }, 400);
      return json(ids.map((id) => (state.items.has(id) ? { code: 200, body: state.items.get(id) } : { code: 404, body: { message: "not found", status: 404 } })));
    }
    const itemGet = path.match(/^\/items\/(MLB\d+)$/);
    if (itemGet) return state.items.has(itemGet[1]) ? json(state.items.get(itemGet[1])) : json({ message: "not found" }, 404);
    const search = path.match(/^\/users\/(\d+)\/items\/search$/);
    if (search) {
      const all = [...state.items.values()].filter((i) => String(i.seller_id) === search[1] && (i.status as string) !== "deleted").map((i) => i.id as string);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ seller_id: search[1], results: all.slice(offset, offset + limit), paging: { total: all.length, offset, limit } });
    }
    const up = path.match(/^\/user-products\/([A-Z0-9]+)$/);
    if (up) return state.userProducts.has(up[1]) ? json(state.userProducts.get(up[1])) : json({ message: "not found" }, 404);
    const order = path.match(/^\/orders\/(\d+)$/);
    if (order) return state.orders.has(order[1]) ? json(state.orders.get(order[1])) : json({ message: "not found" }, 404);
    if (path === "/orders/search") {
      const results = [...state.orders.values()];
      return json({ results, paging: { total: results.length, offset: 0, limit: 50 } });
    }
    const ship = path.match(/^\/shipments\/(\d+)$/);
    if (ship) return state.shipments.has(ship[1]) ? json(state.shipments.get(ship[1])) : json({ message: "not found" }, 404);
    if (path === "/missed_feeds") {
      const topic = url.searchParams.get("topic") ?? "";
      if (topic === "items" && url.searchParams.get("site_id") !== "MLB") return json({ message: "site_id is required", status: 400 }, 400);
      if (url.searchParams.get("app_id") !== APP_ID) return json({ message: "invalid app" }, 403);
      const all = state.missedFeeds[topic] ?? [];
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ messages: all.slice(offset, offset + limit), total: all.length });
    }
    return json({ message: `não simulado: ${method} ${path}` }, 599);
  });
  vi.stubGlobal("fetch", handler);
  return { state, handler };
}

let seq = 0;
/** Notificação no formato documentado pelo ML. */
export function notification(topic: string, resource: string, over: Record<string, unknown> = {}) {
  seq++;
  return {
    _id: `evt-${Date.now()}-${seq}`,
    resource,
    user_id: Number(SELLER),
    topic,
    application_id: Number(APP_ID),
    attempts: 1,
    sent: new Date().toISOString(),
    received: new Date().toISOString(),
    actions: [],
    ...over,
  };
}

export function order(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(id),
    status: "paid",
    status_detail: null,
    date_created: "2026-11-05T12:00:00.000-03:00",
    date_closed: "2026-11-05T12:01:00.000-03:00",
    date_last_updated: "2026-11-05T12:05:00.000-03:00",
    pack_id: null,
    total_amount: 99.9,
    paid_amount: 119.8,
    currency_id: "BRL",
    coupon: { id: null, amount: 0 },
    seller: { id: Number(SELLER) },
    buyer: { id: 777, nickname: "COMPRADOR.TESTE", first_name: "Maria", last_name: "Silva" },
    order_items: [
      { item: { id: "MLB1000", title: "Oxidante 20 vol", seller_sku: "ADS-1804", variation_id: null, category_id: "MLB264861" }, quantity: 1, unit_price: 99.9, full_unit_price: 109.9, sale_fee: 12.5, currency_id: "BRL" },
    ],
    payments: [
      { id: 5550001, status: "approved", status_detail: "accredited", payment_type: "credit_card", payment_method_id: "visa", installments: 1, transaction_amount: 99.9, total_paid_amount: 119.8, shipping_cost: 19.9, date_created: "2026-11-05T12:00:30.000-03:00", date_approved: "2026-11-05T12:00:40.000-03:00", date_last_modified: "2026-11-05T12:00:40.000-03:00" },
    ],
    shipping: { id: 4440001 },
    tags: ["paid"],
    ...over,
  };
}

export function shipment(id: string, orderId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(id),
    order_id: Number(orderId),
    status: "ready_to_ship",
    substatus: "printed",
    logistic: { mode: "me2", type: "drop_off" },
    tracking_method: "Correios",
    date_created: "2026-11-05T12:02:00.000-03:00",
    last_updated: "2026-11-05T12:10:00.000-03:00",
    receiver_address: { street_name: "NÃO DEVE SER GUARDADO" },
    ...over,
  };
}
