import { vi } from "vitest";

/**
 * API do Mercado Livre simulada com estado (itens criados por SELLER_SKU), baseada nas respostas reais
 * observadas em 11/2026 para a categoria MLB264861 (Coloração). Permite simular sucesso, 400, 401, 403,
 * 429, 5xx e timeouts — inclusive o caso "criado, mas a resposta se perdeu".
 */
export const CATEGORY = "MLB264861";
export const SELLER = "42";

export const categoryFixture = {
  id: CATEGORY,
  name: "Coloração",
  path_from_root: [
    { id: "MLB1246", name: "Beleza e Cuidado Pessoal" },
    { id: "MLB1263", name: "Cuidados com o Cabelo" },
    { id: CATEGORY, name: "Coloração" },
  ],
  children_categories: [],
  settings: {
    listing_allowed: true,
    max_title_length: 60,
    max_pictures_per_item: 12,
    max_description_length: 50000,
    minimum_price: 8,
    maximum_price: null,
    item_conditions: ["new", "not_specified"],
    buying_modes: ["auction", "buy_it_now"],
    currencies: ["BRL"],
    status: "enabled",
  },
};

export const attributesFixture = [
  { id: "BRAND", name: "Marca", value_type: "string", tags: { catalog_required: true, required: true }, value_max_length: 255 },
  { id: "NAME", name: "Nome", value_type: "string", tags: { catalog_required: true, required: true }, value_max_length: 255 },
  { id: "GTIN", name: "Código universal de produto", value_type: "string", tags: { multivalued: true, variation_attribute: true, used_hidden: true, validate: true, conditional_required: true }, value_max_length: 255 },
  {
    id: "EMPTY_GTIN_REASON",
    name: "Motivo de GTIN vazio",
    value_type: "list",
    tags: { hidden: true, variation_attribute: true, conditional_required: true },
    values: [
      { id: "17055158", name: "O produto não tem código cadastrado" },
      { id: "17055159", name: "Outro motivo" },
    ],
  },
  { id: "MODEL", name: "Modelo", value_type: "string", tags: { hidden: true }, value_max_length: 255 },
  { id: "SELLER_SKU", name: "SKU", value_type: "string", tags: { hidden: true, variation_attribute: true }, value_max_length: 255 },
  {
    id: "OXIDANT_VOLUMES",
    name: "Volumes de oxidantes",
    value_type: "list",
    tags: {},
    values: [
      { id: "18495513", name: "20" },
      { id: "18495514", name: "30" },
    ],
  },
  {
    id: "NET_VOLUME",
    name: "Volume líquido",
    value_type: "number_unit",
    tags: {},
    allowed_units: [
      { id: "mL", name: "mL" },
      { id: "L", name: "L" },
    ],
    default_unit: "mL",
  },
  { id: "PACKAGE_HEIGHT", name: "Altura da embalagem", value_type: "number_unit", tags: { hidden: true, read_only: true }, allowed_units: [{ id: "cm", name: "cm" }] },
];

export type CreateMode = "ok" | "timeout_after_create" | "timeout_before_create" | "500_created" | "400" | "401" | "429" | "403";

export interface MeliState {
  tags: string[];
  createMode: CreateMode[];
  validateMode: "ok" | "400" | "400warn" | "500";
  /** SKU -> item criado */
  items: Map<string, Record<string, unknown>>;
  nextItem: number;
  calls: { method: string; path: string; body: unknown; auth: string | null }[];
  conditionalRequired: string[];
  tokenRefreshes: number;
  pictureUploads: number;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function pngBytes(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, 800);
  v.setUint32(20, 800);
  return b;
}

export function mockMeliApi(overrides: Partial<MeliState> = {}) {
  const state: MeliState = {
    tags: ["normal", "user_product_seller"],
    createMode: [],
    validateMode: "ok",
    items: new Map(),
    nextItem: 1000,
    calls: [],
    conditionalRequired: ["GTIN"],
    tokenRefreshes: 0,
    pictureUploads: 0,
    ...overrides,
  };

  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    if (url.origin === "https://cdn.test") return new Response(Buffer.from(pngBytes()), { status: 200, headers: { "content-type": "image/png" } });
    if (url.origin !== "https://api.mercadolibre.com") throw new Error(`Chamada inesperada: ${url.href}`);
    const path = url.pathname;
    state.calls.push({ method, path: path + url.search, body, auth: headers.get("authorization") });

    if (path === "/oauth/token") {
      state.tokenRefreshes++;
      return json({ access_token: `APP_USR-NEW-${state.tokenRefreshes}`, token_type: "bearer", expires_in: 21600, scope: "offline_access read write", user_id: 42, refresh_token: `TG-NEW-${state.tokenRefreshes}` });
    }
    const authed = headers.get("authorization")?.startsWith("Bearer ");
    const needAuth = !path.startsWith("/sites/MLB/domain_discovery") && !path.startsWith("/categories/");
    if (needAuth && !authed) return json({ message: "invalid access token", error: "unauthorized", status: 401 }, 401);

    if (method === "GET" && path === "/users/me") return json({ id: 42, nickname: "FIOETRATO", site_id: "MLB", tags: state.tags, email: "nao-deve-ser-guardado@example.com", status: { site_status: "active" } });
    if (method === "GET" && path === "/sites/MLB/domain_discovery/search") {
      return json([
        {
          domain_id: "MLB-HAIR_AND_FACE_DYES_AND_BLEACHES",
          domain_name: "Corantes e descolorantes para cabelo e rosto",
          category_id: CATEGORY,
          category_name: "Coloração",
          attributes: [{ id: "OXIDANT_VOLUMES", name: "Volumes de oxidantes", value_id: "18495513", value_name: "20" }],
        },
      ]);
    }
    if (method === "GET" && path === "/sites/MLB/categories") return json([{ id: "MLB1246", name: "Beleza e Cuidado Pessoal" }]);
    if (method === "GET" && path === `/categories/${CATEGORY}`) return json(categoryFixture);
    if (method === "GET" && path === "/categories/MLB1263") {
      return json({ ...categoryFixture, id: "MLB1263", name: "Cuidados com o Cabelo", children_categories: [{ id: CATEGORY, name: "Coloração" }] });
    }
    if (method === "GET" && path === `/categories/${CATEGORY}/attributes`) return json(attributesFixture);
    if (method === "GET" && path === `/categories/${CATEGORY}/technical_specs/input`) return json({ message: "not found" }, 404);
    if (method === "POST" && path === `/categories/${CATEGORY}/attributes/conditional`) {
      return json({ required_attributes: state.conditionalRequired.map((id) => ({ id })) });
    }
    if (method === "GET" && path === `/users/${SELLER}/available_listing_types`) {
      return json({ available: [{ site_id: "MLB", id: "gold_special", name: "Clássico" }, { site_id: "MLB", id: "gold_pro", name: "Premium" }] });
    }
    if (method === "GET" && path === "/products/search") {
      const gtin = url.searchParams.get("product_identifier");
      return json({ results: gtin === "7896014106226" ? [{ id: "MLB19999999", name: "Oxidante L'Oréal 20 vol 950ml", domain_id: "MLB-HAIR_AND_FACE_DYES_AND_BLEACHES", status: "active", attributes: [{ id: "BRAND", name: "Marca", value_name: "L'Oréal" }, { id: "GTIN", name: "GTIN", value_name: gtin }], pictures: [] }] : [] });
    }
    if (method === "POST" && path === "/items/validate") {
      if (state.validateMode === "400") return json({ message: "Validation error", error: "validation_error", status: 400, cause: [{ code: "item.attributes.missing_required", message: "The attributes [BRAND] are required", type: "error" }, { code: "item.title.length", message: "Title is long", type: "warning" }] }, 400);
      if (state.validateMode === "400warn") return json({ message: "seller.unable_to_list", error: "validation_error", status: 400, cause: [{ code: "shipping.lost_me1_by_user", message: "User has not mode me1", type: "warning" }, { code: "item.shipping.mandatory_free_shipping", message: "Mandatory free shipping added", type: "warning" }] }, 400);
      if (state.validateMode === "500") return json({ message: "internal error" }, 500);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/pictures/items/upload") {
      state.pictureUploads++;
      return json({ id: `PIC-${state.pictureUploads}`, max_size: "800x800" }, 201);
    }
    const search = path.match(/^\/users\/(\d+)\/items\/search$/);
    if (method === "GET" && search) {
      const sku = url.searchParams.get("seller_sku") ?? "";
      // Itens com o SKU, inclusive anúncios antigos guardados como "<sku>#<id>" (republicação).
      const ids = [...state.items.entries()].filter(([k]) => k === sku || k.startsWith(`${sku}#`)).map(([, v]) => v.id);
      return json({ seller_id: search[1], results: ids, paging: { total: ids.length } });
    }
    if (method === "GET" && path === "/items" && url.searchParams.get("ids")) {
      const ids = url.searchParams.get("ids")!.split(",");
      return json(
        ids.map((id) => {
          const item = [...state.items.values()].find((i) => i.id === id);
          return item ? { code: 200, body: item } : { code: 404, body: { message: "Item not found", error: "not_found", status: 404 } };
        }),
      );
    }
    const itemGet = path.match(/^\/items\/(MLB\d+)$/);
    if (method === "GET" && itemGet) {
      const item = [...state.items.values()].find((i) => i.id === itemGet[1]);
      return item ? json(item) : json({ message: "not found" }, 404);
    }
    if (method === "POST" && /^\/items\/MLB\d+\/description$/.test(path)) return json({ text: "", plain_text: (body as { plain_text?: string })?.plain_text ?? "" }, 201);

    if (method === "POST" && path === "/items") {
      const mode = state.createMode.shift() ?? "ok";
      const payload = body as Record<string, unknown>;
      const sku = ((payload.attributes as { id: string; value_name?: string }[]) ?? []).find((a) => a.id === "SELLER_SKU")?.value_name ?? "";
      const create = () => {
        const id = `MLB${state.nextItem++}`;
        const item = {
          id,
          permalink: `https://produto.mercadolivre.com.br/${id.replace("MLB", "MLB-")}-teste`,
          status: "active",
          user_product_id: payload.family_name ? `MLBU${id.slice(3)}` : null,
          family_id: payload.family_name ? 777 : null,
          price: payload.price,
          available_quantity: payload.available_quantity,
          listing_type_id: payload.listing_type_id,
          category_id: payload.category_id,
          title: payload.title ?? payload.family_name,
        };
        const previous = state.items.get(sku);
        if (previous) state.items.set(`${sku}#${String(previous.id)}`, previous);
        state.items.set(sku, item);
        return item;
      };
      switch (mode) {
        case "timeout_after_create":
          create();
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        case "timeout_before_create":
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        case "500_created":
          create();
          return json({ message: "internal error" }, 500);
        case "400":
          return json({ message: "Validation error", error: "validation_error", status: 400, cause: [{ code: "item.price.invalid", message: "Invalid price", type: "error" }] }, 400);
        case "401":
          return json({ message: "invalid access token", error: "unauthorized", status: 401 }, 401);
        case "403":
          return json({ message: "forbidden", error: "forbidden", status: 403 }, 403);
        case "429":
          return json({ message: "too many requests", error: "local_rate_limited", status: 429 }, 429, { "retry-after": "1" });
        default:
          return json(create(), 201);
      }
    }
    return json({ message: `não simulado: ${method} ${path}` }, 599);
  });
  vi.stubGlobal("fetch", handler);
  return { state, handler, createCalls: () => state.calls.filter((c) => c.method === "POST" && c.path === "/items") };
}
