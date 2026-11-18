import { vi } from "vitest";

/**
 * Nuvemshop simulada (Admin API 2025-03 + servidor de autorização). Somente valores de teste.
 * Registra todas as chamadas; qualquer método diferente de GET na API é registrado em `writes`.
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
    NUVEMSHOP_PHASE1_READ_ONLY: "true",
  };
}

export interface FakeVariant {
  id: number;
  product_id?: number;
  sku?: string | null;
  barcode?: string | null;
  price?: string;
  stock_management?: boolean;
  stock?: number | null;
  inventory_levels?: { location_id: string; stock: number | null }[];
  values?: Record<string, string>[];
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
  updated_at?: string;
  created_at?: string;
}

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
  locations: { id: string; name: Record<string, string>; is_default?: boolean; priority?: number }[] = [{ id: "LOC-A", name: { pt_BR: "Depósito A" }, is_default: true, priority: 0 }];
  categories = [{ id: 1, name: { pt: "Cabelos" }, parent: null }];
  calls: { method: string; url: string }[] = [];
  writes: { method: string; url: string }[] = [];
  /** Respostas forçadas por caminho (consumidas em ordem): status ou "network"/"timeout". */
  failures = new Map<string, (number | "network" | "timeout")[]>();
  tokenExchangeStatus = 200;
  /** Erro devolvido no corpo da troca do code (simula code inválido). */
  tokenError: string | null = null;
  rateHeaders: Record<string, string> = { "x-rate-limit-limit": "40", "x-rate-limit-remaining": "39", "x-rate-limit-reset": "0" };

  readonly fetch = vi.fn(async (input: unknown, init?: RequestInit) => this.handle(String(input instanceof Request ? input.url : input), init ?? {}));

  private json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...this.rateHeaders, ...headers } });
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
    if (method !== "GET") {
      this.writes.push({ method, url });
      return this.json({ error: "write not allowed in test" }, 405);
    }
    const headers = new Headers(init.headers);
    if (!headers.get("user-agent")) return this.json({ error: "User-Agent required" }, 400);
    if (headers.get("authorization") !== `Bearer ${this.token}`) return this.json({ code: 401, message: "Unauthorized", description: "Invalid access token" }, 401);
    const path = u.pathname.replace(`/2025-03/${NS_STORE}`, "");
    const forced = this.failures.get(path);
    if (forced?.length) {
      const f = forced.shift()!;
      if (f === "network") throw new TypeError("fetch failed");
      if (f === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return this.json({ code: f, message: "forced" }, f, f === 429 ? { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "5" } : {});
    }
    if (path === "/store") return this.json(this.store);
    if (path === "/locations") return this.json(this.locations);
    if (path === "/categories") return this.page(u, this.categories);
    if (path === "/products") {
      const since = u.searchParams.get("updated_at_min");
      const list = this.products
        .filter((p) => !since || new Date(p.updated_at ?? "2026-01-01T00:00:00Z") >= new Date(since))
        .map((p) => this.productPayload(p));
      return this.page(u, list);
    }
    const m = /^\/products\/(\d+)\/variants$/.exec(path);
    if (m) {
      const p = this.products.find((x) => x.id === Number(m[1]));
      if (!p) return this.json({ code: 404, message: "Not Found" }, 404);
      return this.page(u, (p.variants ?? []).map((v) => this.variantPayload(p, v)));
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
      promotional_price: null,
      stock_management: v.stock_management ?? true,
      stock: v.stock === undefined ? 5 : v.stock,
      ...(v.inventory_levels ? { inventory_levels: v.inventory_levels.map((l, i) => ({ id: String(i + 1), variant_id: String(v.id), ...l })) } : {}),
      values: v.values ?? [],
      visible: true,
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
      published: p.published ?? true,
      is_kit: p.is_kit ?? false,
      attributes: [],
      categories: [{ id: 1 }],
      tags: "",
      canonical_url: `https://loja.test/produtos/p-${p.id}`,
      images: p.images ?? [],
      created_at: p.created_at ?? "2026-01-01T10:00:00+0000",
      updated_at: p.updated_at ?? "2026-01-01T10:00:00+0000",
      ...(p.omitVariants ? {} : { variants: (p.variants ?? []).map((v) => this.variantPayload(p, v)) }),
    };
  }
}
