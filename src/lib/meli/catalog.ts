import "server-only";
import { meliRequest } from "./api";

/**
 * Identificação de produtos de catálogo do Mercado Livre (GET /products/search).
 * Apenas consulta: o vínculo ao catálogo só acontece se o operador escolher explicitamente.
 */
export interface CatalogMatch {
  id: string;
  name: string;
  domainId: string | null;
  status: string | null;
  brand: string | null;
  model: string | null;
  gtins: string[];
  attributes: { id: string; name: string; valueName: string | null }[];
  thumbnail: string | null;
}

function attr(attrs: Record<string, unknown>[], id: string): string | null {
  const a = attrs.find((x) => x.id === id);
  return a && typeof a.value_name === "string" ? a.value_name : null;
}

export function isValidGtin(code: string | null | undefined): boolean {
  if (!code || !/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export async function searchCatalog(opts: { gtin?: string | null; q?: string | null }): Promise<{ by: "gtin" | "q" | null; matches: CatalogMatch[] }> {
  let by: "gtin" | "q" | null = null;
  const query: Record<string, string> = { status: "active", site_id: "MLB" };
  if (opts.gtin && isValidGtin(opts.gtin)) {
    query.product_identifier = opts.gtin;
    by = "gtin";
  } else if (opts.q?.trim()) {
    query.q = opts.q.trim().slice(0, 120);
    by = "q";
  } else return { by: null, matches: [] };

  const { data } = await meliRequest<{ results?: unknown[] }>("/products/search", { auth: true, query });
  const results = Array.isArray(data?.results) ? data.results.slice(0, 10) : [];
  return {
    by,
    matches: results.map((r) => {
      const p = r as Record<string, unknown>;
      const attrs = Array.isArray(p.attributes) ? (p.attributes as Record<string, unknown>[]) : [];
      const pictures = Array.isArray(p.pictures) ? (p.pictures as Record<string, unknown>[]) : [];
      return {
        id: String(p.id),
        name: String(p.name ?? ""),
        domainId: typeof p.domain_id === "string" ? p.domain_id : null,
        status: typeof p.status === "string" ? p.status : null,
        brand: attr(attrs, "BRAND"),
        model: attr(attrs, "MODEL"),
        gtins: attrs.filter((a) => a.id === "GTIN" && typeof a.value_name === "string").map((a) => a.value_name as string),
        attributes: attrs.slice(0, 40).map((a) => ({ id: String(a.id), name: String(a.name ?? a.id), valueName: typeof a.value_name === "string" ? a.value_name : null })),
        thumbnail: typeof pictures[0]?.url === "string" ? (pictures[0].url as string) : null,
      };
    }),
  };
}
