import "server-only";
import type { Sql } from "../sql";
import { meliRequest, MeliHttpError } from "./api";

/**
 * Categorias, atributos e especificações técnicas do Mercado Livre (site MLB), com cache no banco.
 * Os formulários são montados a partir destas respostas reais — nada é fixado no código.
 */
export const CATEGORY_ID = /^MLB\d{1,12}$/;
const TTL_HOURS = 24;

export interface CategorySettings {
  listing_allowed?: boolean;
  max_title_length?: number;
  max_pictures_per_item?: number;
  max_description_length?: number;
  minimum_price?: number | null;
  maximum_price?: number | null;
  item_conditions?: string[];
  buying_modes?: string[];
  currencies?: string[];
  status?: string;
  [key: string]: unknown;
}

export interface CategoryDetail {
  id: string;
  name: string;
  path_from_root: { id: string; name: string }[];
  children_categories: { id: string; name: string; total_items_in_this_category?: number }[];
  settings: CategorySettings;
}

export interface MeliAttribute {
  id: string;
  name: string;
  value_type: string;
  tags?: Record<string, boolean>;
  values?: { id: string; name: string }[];
  allowed_units?: { id: string; name: string }[];
  default_unit?: string;
  value_max_length?: number;
  attribute_group_id?: string;
  attribute_group_name?: string;
  hint?: string;
  tooltip?: string;
  relevance?: number;
  hierarchy?: string;
}

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  domainId: string | null;
  domainName: string | null;
  attributes: { id: string; name: string; valueId: string | null; valueName: string | null }[];
}

export function assertCategoryId(id: string): string {
  if (!CATEGORY_ID.test(id)) throw new MeliHttpError("bad_request", 400, "Categoria inválida (formato MLB123)");
  return id;
}

type CacheColumn = "category_json" | "attributes_json" | "technical_specs_json";

async function cached<T>(sql: Sql, categoryId: string, column: CacheColumn, load: () => Promise<T>, name?: (v: T) => string | null): Promise<T> {
  const [row] = await sql.query<{ value: T | null; fresh: boolean }>(
    `SELECT ${column} AS value, expires_at > now() AS fresh FROM marketplace_category_cache WHERE category_id = $1`,
    [categoryId],
  );
  if (row?.fresh && row.value !== null) return row.value;
  const value = await load();
  await sql.execute(
    `INSERT INTO marketplace_category_cache (category_id, category_name, ${column}, fetched_at, expires_at)
     VALUES ($1, $2, $3::jsonb, now(), now() + make_interval(hours => $4::int))
     ON CONFLICT (category_id) DO UPDATE SET ${column} = EXCLUDED.${column},
       category_name = COALESCE(EXCLUDED.category_name, marketplace_category_cache.category_name),
       fetched_at = now(), expires_at = EXCLUDED.expires_at`,
    [categoryId, name ? name(value) : null, JSON.stringify(value), TTL_HOURS],
  );
  return value;
}

/** Preditor oficial: GET /sites/MLB/domain_discovery/search. Sugestões; a escolha é do operador. */
export async function suggestCategories(q: string, limit = 5): Promise<CategorySuggestion[]> {
  const query = q.trim().slice(0, 200);
  if (!query) return [];
  const { data } = await meliRequest<unknown[]>("/sites/MLB/domain_discovery/search", { query: { q: query, limit }, auth: "optional" });
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => d as Record<string, unknown>)
    .filter((d) => typeof d.category_id === "string" && CATEGORY_ID.test(d.category_id))
    .map((d) => ({
      categoryId: d.category_id as string,
      categoryName: String(d.category_name ?? ""),
      domainId: typeof d.domain_id === "string" ? d.domain_id : null,
      domainName: typeof d.domain_name === "string" ? d.domain_name : null,
      attributes: Array.isArray(d.attributes)
        ? (d.attributes as Record<string, unknown>[]).map((a) => ({
            id: String(a.id),
            name: String(a.name ?? a.id),
            valueId: typeof a.value_id === "string" ? a.value_id : null,
            valueName: typeof a.value_name === "string" ? a.value_name : null,
          }))
        : [],
    }));
}

export async function getCategory(sql: Sql, categoryId: string): Promise<CategoryDetail> {
  assertCategoryId(categoryId);
  return cached(
    sql,
    categoryId,
    "category_json",
    async () => {
      const { data } = await meliRequest<CategoryDetail>(`/categories/${categoryId}`, { auth: "optional" });
      return {
        id: data.id,
        name: data.name,
        path_from_root: data.path_from_root ?? [],
        children_categories: data.children_categories ?? [],
        settings: data.settings ?? {},
      };
    },
    (v) => v.name,
  );
}

/** Raiz da árvore do site MLB (o endpoint exige token). */
export async function getRootCategories(sql: Sql): Promise<{ id: string; name: string }[]> {
  return cached(sql, "MLB", "category_json", async () => {
    const { data } = await meliRequest<{ id: string; name: string }[]>("/sites/MLB/categories", { auth: "optional" });
    return Array.isArray(data) ? data.map((c) => ({ id: c.id, name: c.name })) : [];
  });
}

export async function getCategoryAttributes(sql: Sql, categoryId: string): Promise<MeliAttribute[]> {
  assertCategoryId(categoryId);
  return cached(sql, categoryId, "attributes_json", async () => {
    const { data } = await meliRequest<MeliAttribute[]>(`/categories/${categoryId}/attributes`, { auth: "optional" });
    return Array.isArray(data) ? data : [];
  });
}

/** Especificações técnicas (agrupamento/ordem dos campos). Nem toda categoria possui; null quando indisponível. */
export async function getTechnicalSpecs(sql: Sql, categoryId: string): Promise<unknown | null> {
  assertCategoryId(categoryId);
  return cached(sql, categoryId, "technical_specs_json", async () => {
    try {
      const { data } = await meliRequest<unknown>(`/categories/${categoryId}/technical_specs/input`, { auth: "optional" });
      return data ?? null;
    } catch (err) {
      if (err instanceof MeliHttpError && (err.kind === "not_found" || err.kind === "forbidden" || err.kind === "bad_request")) return null;
      throw err;
    }
  });
}

export interface DraftAttribute {
  id: string;
  value_id?: string | null;
  value_name?: string | null;
  values?: { id?: string | null; name?: string | null }[];
}

/**
 * Atributos obrigatórios condicionados aos valores informados
 * (POST /categories/{id}/attributes/conditional). Retorna null se o recurso não responder —
 * nesse caso valem só as tags estáticas `required`/`conditional_required`.
 */
export async function getConditionalRequired(categoryId: string, attributes: DraftAttribute[]): Promise<string[] | null> {
  assertCategoryId(categoryId);
  try {
    const { data } = await meliRequest<unknown>(`/categories/${categoryId}/attributes/conditional`, {
      method: "POST",
      auth: "optional",
      body: { category_id: categoryId, attributes: attributes.filter((a) => a.value_id || a.value_name || a.values?.length) },
    });
    const o = data as Record<string, unknown> | unknown[];
    const list = Array.isArray(o) ? o : Array.isArray((o as Record<string, unknown>)?.required_attributes) ? ((o as Record<string, unknown>).required_attributes as unknown[]) : [];
    return list.map((x) => (typeof x === "string" ? x : String((x as { id?: unknown })?.id ?? ""))).filter(Boolean);
  } catch {
    return null;
  }
}

/** Tipos de anúncio disponíveis para a conta nesta categoria. */
export async function getAvailableListingTypes(meliUserId: string, categoryId: string): Promise<{ id: string; name: string }[]> {
  assertCategoryId(categoryId);
  if (!/^\d{1,20}$/.test(meliUserId)) return [];
  const { data } = await meliRequest<unknown>(`/users/${meliUserId}/available_listing_types`, { auth: true, query: { category_id: categoryId } });
  const raw = Array.isArray(data) ? data : Array.isArray((data as { available?: unknown })?.available) ? (data as { available: unknown[] }).available : [];
  return raw.map((t) => t as Record<string, unknown>).filter((t) => typeof t.id === "string").map((t) => ({ id: t.id as string, name: String(t.name ?? t.id) }));
}
