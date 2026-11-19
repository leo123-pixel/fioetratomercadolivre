import { vi } from "vitest";

/**
 * Nuvemshop simulada (Admin API 2025-03 + servidor de autorização). Somente valores de teste.
 * Registra todas as chamadas; toda escrita (POST/PUT/PATCH/DELETE) na API é registrada em `writes` (com o corpo)
 * e aplicada ao estado simulado — produtos, variantes (estoque por localização), imagens, webhooks e pedidos.
 */
export const NS_APP_ID = "9876";
export const NS_SECRET = "ns-test-client-secret";
export const NS_STORE = "4242";
export const NS_TOKEN = "ns-test-access-token-1";
export const API = `https://api.tiendanube.com/2025-03/${NS_STORE}`;

export function nsEnv() {
  return {
    NUVEMSHOP_APP_ID: NS_APP_ID,
    NUVEMSHOP_CLIENT_SECRET: NS_SECRET,
    NUVEMSHOP_REDIRECT_URI: "https://integrador.test/api/auth/nuvemshop/callback",
  };
}

export interface FakeVariant {
  id: number;
  product_id?: number;
  sku?: string | null;
  barcode?: string | null;
  price?: string;
  promotional_price?: string | null;
  stock_management?: boolean;
  stock?: number | null;
  inventory_levels?: { location_id: string; stock: number | null }[];
  values?: Record<string, string>[];
  visible?: boolean;
  updated_at?: string;
}

export interface FakeProduct {
  id: number;
  name: Record<string, string>;
  brand?: string | null;
  visibility?: string;
  published?: boolean;
  is_kit?: boolean;
  variants?: FakeVariant[];
  /** Se true, o produto vem sem a lista de variantes embutida (força GET /products/{id}/variants). */
  omitVariants?: boolean;
  images?: { id: number; src: string; position?: number }[];
  categories?: number[];
  updated_at?: string;
  created_at?: string;
}

export interface FakeOrder {
  id: number;
  number?: number;
  status?: string;
  payment_status?: string;
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string | null;
  products: { id: number; product_id: number; variant_id: number | string; quantity: number | string; sku?: string | null; name?: string }[];
  contact_email?: string;
  contact_name?: string;
}

export type Forced = number | "network" | "timeout" | "timeout_applied" | "server_applied";

export class FakeNuvemshop {
  store: Record<string, unknown> = {
    id: Number(NS_STORE),
    name: { pt: "Loja Teste" },
    url_with_protocol: "https://loja.test",
    original_domain: "loja.lojavirtualnuvem.com.br",
    plan_name: "BR_test_plan",
    main_language: "pt",
    main_currency: "BRL",
    country: "BR",
    email: "dono@exemplo.test",
  };
  storeIdForToken = NS_STORE;
  token = NS_TOKEN;
  scope = "read_products,read_locations";
  products: FakeProduct[] = [];
  orders: FakeOrder[] = [];
  webhooks: { id: number; event: string; url: string }[] = [];
  locations: { id: string; name: Record<string, string>; is_default?: boolean; priority?: number }[] = [{ id: "LOC-A", name: { pt_BR: "Depósito A" }, is_default: true, priority: 0 }];
  categories = [{ id: 1, name: { pt: "Cabelos" }, parent: null }];
  calls: { method: string; url: string }[] = [];
  writes: { method: string; url: string; path: string; body: unknown }[] = [];
  /** Respostas forçadas por caminho (consumidas em ordem): status, "network"/"timeout" (não aplicado) ou "timeout_applied"/"server_applied" (aplicado, mas a resposta se perde). */
  failures = new Map<string, Forced[]>();
  /** Chamado depois de aplicar uma escrita (ex.: simular venda logo depois). */
  afterWrite: ((path: string) => void) | null = null;
  /** Variantes que o PATCH stock-price responde como success:false (sem aplicar). */
  rejectVariants = new Set<number>();
  tokenExchangeStatus = 200;
  /** Erro devolvido no corpo da troca do code (simula code inválido). */
  tokenError: string | null = null;
  rateHeaders: Record<string, string> = { "x-rate-limit-limit": "40", "x-rate-limit-remaining": "39", "x-rate-limit-reset": "0" };
  private nextId = 900_000;

  readonly fetch = vi.fn(async (input: unknown, init?: RequestInit) => this.handle(String(input instanceof Request ? input.url : input), init ?? {}));

  private json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...this.rateHeaders, ...headers } });
  }

  variant(id: number): FakeVariant | undefined {
    for (const p of this.products) for (const v of p.variants ?? []) if (v.id === id) return v;
    return undefined;
  }

  /** Estoque da variante numa localização (ou o total). */
  stockOf(id: number, locationId?: string): number | null | undefined {
    const v = this.variant(id);
    if (!v) return undefined;
    if (v.inventory_levels && locationId) return v.inventory_levels.find((l) => l.location_id === locationId)?.stock;
    return v.stock === undefined ? 5 : v.stock;
  }

  /** Venda simulada: a loja desconta o próprio estoque. */
  sell(variantId: number, qty: number, locationId?: string) {
    const v = this.variant(variantId)!;
    if (v.inventory_levels) {
      const l = v.inventory_levels.find((x) => !locationId || x.location_id === locationId)!;
      l.stock = Math.max(0, (l.stock ?? 0) - qty);
      v.stock = v.inventory_levels.reduce((a, x) => a + (x.stock ?? 0), 0);
    } else v.stock = Math.max(0, (v.stock === undefined ? 5 : (v.stock ?? 0)) - qty);
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ method, url });
    const u = new URL(url);
    if (u.hostname === "www.nuvemshop.com.br" && u.pathname === "/apps/authorize/token") {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (this.tokenError || body.client_secret !== NS_SECRET || body.grant_type !== "authorization_code") {
        return this.json({ error: this.tokenError ?? "invalid_client", error_description: "falha" }, this.tokenExchangeStatus === 200 ? 400 : this.tokenExchangeStatus);
      }
      return this.json({ access_token: this.token, token_type: "bearer", scope: this.scope, user_id: this.storeIdForToken });
    }
    if (u.hostname !== "api.tiendanube.com") throw new Error(`Host inesperado: ${url}`);
    const headers = new Headers(init.headers);
    if (!headers.get("user-agent")) return this.json({ error: "User-Agent required" }, 400);
    if (headers.get("authorization") !== `Bearer ${this.token}`) return this.json({ code: 401, message: "Unauthorized", description: "Invalid access token" }, 401);
    const path = u.pathname.replace(`/2025-03/${NS_STORE}`, "");
    const forced = this.failures.get(path);
    let afterApply: Forced | null = null;
    if (forced?.length) {
      const f = forced.shift()!;
      if (f === "network") throw new TypeError("fetch failed");
      if (f === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (f === "timeout_applied" || f === "server_applied") afterApply = f;
      else return this.json({ code: f, message: "forced", description: f === 422 ? "Validation error" : "forced" }, f, f === 429 ? { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "5" } : {});
    }
    if (method !== "GET") {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      this.writes.push({ method, url, path, body });
      const res = this.write(method, path, body);
      this.afterWrite?.(path);
      if (afterApply === "timeout_applied") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (afterApply === "server_applied") return this.json({ code: 500, message: "Internal Server Error" }, 500);
      return res;
    }
    if (path === "/store") return this.json(this.store);
    if (path === "/locations") return this.json(this.locations);
    if (path === "/categories") return this.page(u, this.categories);
    if (path === "/webhooks") return this.json(this.webhooks.filter((w) => !u.searchParams.get("url") || w.url === u.searchParams.get("url")));
    if (path === "/products") {
      const since = u.searchParams.get("updated_at_min");
      const ids = u.searchParams.get("ids")?.split(",").map(Number);
      const q = u.searchParams.get("q");
      const list = this.products
        .filter((p) => !since || new Date(p.updated_at ?? "2026-01-01T00:00:00Z") >= new Date(since))
        .filter((p) => !ids || ids.includes(p.id))
        .filter((p) => !q || (p.variants ?? []).some((v) => v.sku === q))
        .map((p) => this.productPayload(p));
      return ids ? this.json(list) : this.page(u, list);
    }
    const one = /^\/products\/(\d+)$/.exec(path);
    if (one) {
      const p = this.products.find((x) => x.id === Number(one[1]));
      return p ? this.json(this.productPayload(p)) : this.json({ code: 404, message: "Not Found" }, 404);
    }
    const m = /^\/products\/(\d+)\/variants$/.exec(path);
    if (m) {
      const p = this.products.find((x) => x.id === Number(m[1]));
      if (!p) return this.json({ code: 404, message: "Not Found" }, 404);
      return this.page(u, (p.variants ?? []).map((v) => this.variantPayload(p, v)));
    }
    if (path === "/orders") {
      const since = u.searchParams.get("updated_at_min");
      return this.page(u, this.orders.filter((o) => !since || new Date(o.updated_at ?? "2026-11-01T00:00:00Z") >= new Date(since)));
    }
    const order = /^\/orders\/(\d+)$/.exec(path);
    if (order) {
      const o = this.orders.find((x) => x.id === Number(order[1]));
      return o ? this.json(o) : this.json({ code: 404, message: "Not Found" }, 404);
    }
    return this.json({ code: 404, message: "Not Found" }, 404);
  }

  private touch(p: FakeProduct) {
    p.updated_at = new Date(Date.now() + 1000).toISOString();
  }

  private write(method: string, path: string, body: any): Response {
    if (method === "PATCH" && path === "/products/stock-price") {
      if (!Array.isArray(body) || body.reduce((a: number, p: any) => a + (p.variants?.length ?? 0), 0) > 50) return this.json({ code: 422, message: "Unprocessable Entity", description: "Too many variants sent for update" }, 422);
      const out = [];
      for (const pb of body) {
        const p = this.products.find((x) => x.id === pb.id);
        if (!p) return this.json({ code: 422, message: "Unprocessable Entity", description: "Product not found" }, 422);
        const vs = [];
        for (const vb of pb.variants) {
          const v = (p.variants ?? []).find((x) => x.id === vb.id);
          if (!v) return this.json({ code: 422, message: "Unprocessable Entity", description: "Variant not found" }, 422);
          if (this.rejectVariants.has(v.id)) {
            vs.push({ id: v.id, success: false });
            continue;
          }
          if (vb.price !== undefined) v.price = Number(vb.price).toFixed(2);
          if (vb.promotional_price !== undefined) v.promotional_price = vb.promotional_price;
          for (const l of vb.inventory_levels ?? []) {
            if (typeof l.stock !== "number" || l.stock < 0) return this.json({ code: 422, message: "Unprocessable Entity", description: "Validation error", stock: ["The stock must be at least 0."] }, 422);
            if (v.inventory_levels) {
              const level = v.inventory_levels.find((x) => (l.location_id ? x.location_id === l.location_id : true));
              if (!level) return this.json({ code: 422, message: "Unprocessable Entity", description: "Location id is invalid" }, 422);
              level.stock = l.stock;
              v.stock = v.inventory_levels.reduce((a, x) => a + (x.stock ?? 0), 0);
            } else v.stock = l.stock;
          }
          v.updated_at = new Date(Date.now() + 1000).toISOString();
          vs.push({ id: v.id, success: true });
        }
        this.touch(p);
        out.push({ id: p.id, variants: vs });
      }
      return this.json(out);
    }
    if (method === "POST" && path === "/products") {
      const id = ++this.nextId;
      const p: FakeProduct = {
        id,
        name: body.name,
        brand: body.brand ?? null,
        visibility: body.visibility ?? "visible",
        categories: body.categories,
        images: (body.images ?? []).map((i: any, n: number) => ({ id: ++this.nextId, src: i.src, position: n + 1 })),
        variants: (body.variants ?? []).map((v: any) => ({ id: ++this.nextId, sku: v.sku, barcode: v.barcode ?? null, price: v.price, stock_management: true, stock: v.stock ?? 0 })),
        created_at: new Date().toISOString(),
      };
      this.touch(p);
      this.products.push(p);
      return this.json(this.productPayload(p), 201);
    }
    const prod = /^\/products\/(\d+)$/.exec(path);
    if (prod && method === "PUT") {
      const p = this.products.find((x) => x.id === Number(prod[1]));
      if (!p) return this.json({ code: 404, message: "Not Found" }, 404);
      if (body.variants || body.images) return this.json({ code: 422, message: "Unprocessable Entity", description: "Validation error", variants: ["The variants must not be present."] }, 422);
      if (body.name) p.name = body.name;
      if (body.brand !== undefined) p.brand = body.brand;
      if (body.visibility) p.visibility = body.visibility;
      if (body.categories) p.categories = body.categories;
      this.touch(p);
      return this.json(this.productPayload(p));
    }
    const vars = /^\/products\/(\d+)\/variants$/.exec(path);
    if (vars && method === "POST") {
      const p = this.products.find((x) => x.id === Number(vars[1]))!;
      const v: FakeVariant = { id: ++this.nextId, sku: body.sku, price: body.price, stock_management: true, stock: body.stock ?? 0, values: body.values };
      (p.variants ??= []).push(v);
      this.touch(p);
      return this.json(this.variantPayload(p, v), 201);
    }
    const onev = /^\/products\/(\d+)\/variants\/(\d+)$/.exec(path);
    if (onev && method === "PUT") {
      const p = this.products.find((x) => x.id === Number(onev[1]))!;
      const v = (p.variants ?? []).find((x) => x.id === Number(onev[2]));
      if (!v) return this.json({ code: 404, message: "Not Found" }, 404);
      if (body.price !== undefined) v.price = body.price;
      if (body.sku !== undefined) v.sku = body.sku;
      if (body.visible !== undefined) v.visible = body.visible;
      this.touch(p);
      return this.json(this.variantPayload(p, v));
    }
    const imgs = /^\/products\/(\d+)\/images$/.exec(path);
    if (imgs && method === "POST") {
      const p = this.products.find((x) => x.id === Number(imgs[1]))!;
      const img = { id: ++this.nextId, src: `https://cdn.nuvem.test/${this.nextId}.jpg`, position: body.position ?? (p.images?.length ?? 0) + 1 };
      (p.images ??= []).push(img);
      this.touch(p);
      return this.json(img, 201);
    }
    const img = /^\/products\/(\d+)\/images\/(\d+)$/.exec(path);
    if (img) {
      const p = this.products.find((x) => x.id === Number(img[1]))!;
      const i = (p.images ?? []).find((x) => x.id === Number(img[2]));
      if (!i) return this.json({ code: 404, message: "Not Found" }, 404);
      if (method === "DELETE") p.images = (p.images ?? []).filter((x) => x.id !== i.id);
      else if (method === "PUT" && body.position) {
        for (const o of p.images ?? []) if (o.id !== i.id && (o.position ?? 0) >= body.position) o.position = (o.position ?? 0) + 1;
        i.position = body.position;
      }
      this.touch(p);
      return this.json(method === "DELETE" ? {} : i);
    }
    if (method === "POST" && path === "/webhooks") {
      const w = { id: ++this.nextId, event: body.event, url: body.url };
      this.webhooks.push(w);
      return this.json(w, 201);
    }
    return this.json({ code: 404, message: "Not Found" }, 404);
  }

  private page(u: URL, items: unknown[]) {
    const page = Number(u.searchParams.get("page") ?? 1);
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const last = Math.max(1, Math.ceil(items.length / per));
    if (page > last && items.length) return this.json({ code: 404, message: "Not Found", description: `Last page is ${last}` }, 404);
    const slice = items.slice((page - 1) * per, page * per);
    const link = page < last ? `<https://api.tiendanube.com/next?page=${page + 1}>; rel="next"` : "";
    return this.json(slice, 200, { "x-total-count": String(items.length), ...(link ? { link } : {}) });
  }

  private variantPayload(p: FakeProduct, v: FakeVariant) {
    return {
      id: v.id,
      product_id: p.id,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null,
      price: v.price ?? "10.00",
      promotional_price: v.promotional_price ?? null,
      stock_management: v.stock_management ?? true,
      stock: v.stock === undefined ? 5 : v.stock,
      ...(v.inventory_levels ? { inventory_levels: v.inventory_levels.map((l, i) => ({ id: String(i + 1), variant_id: String(v.id), ...l })) } : {}),
      values: v.values ?? [],
      visible: v.visible ?? true,
      weight: "0.30",
      created_at: "2026-01-01T10:00:00-0300",
      updated_at: v.updated_at ?? p.updated_at ?? "2026-01-01T10:00:00-0300",
    };
  }

  private productPayload(p: FakeProduct) {
    return {
      id: p.id,
      name: p.name,
      description: { pt: "<p>desc</p>" },
      handle: { pt: `p-${p.id}` },
      brand: p.brand ?? null,
      visibility: p.visibility ?? "visible",
      published: p.published ?? (p.visibility ?? "visible") === "visible",
      is_kit: p.is_kit ?? false,
      attributes: [],
      categories: (p.categories ?? [1]).map((id) => ({ id })),
      tags: "",
      canonical_url: `https://loja.test/produtos/p-${p.id}`,
      images: p.images ?? [],
      created_at: p.created_at ?? "2026-01-01T10:00:00+0000",
      updated_at: p.updated_at ?? "2026-01-01T10:00:00+0000",
      ...(p.omitVariants ? {} : { variants: (p.variants ?? []).map((v) => this.variantPayload(p, v)) }),
    };
  }
}
