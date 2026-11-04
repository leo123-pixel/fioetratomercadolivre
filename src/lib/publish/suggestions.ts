import "server-only";
import { isValidGtin } from "../meli/catalog";
import type { MeliAttribute } from "../meli/categories";
import type { Sql } from "../sql";

/**
 * Sugestões de atributos a partir dos dados da ADS — apenas correspondências confiáveis:
 * - GTIN ← EAN-13 com dígito verificador válido;
 * - BRAND ← campo "marca" da ADS quando preenchido (muitos registros vêm vazios: preenchimento manual);
 * - volume/peso ← apresentação no formato exato "950ML", "1L", "500G", se a unidade for aceita pela categoria.
 * Nada é aplicado sem ação do operador; atributos desconhecidos nunca recebem valor inventado.
 */
export interface AttributeSuggestion {
  id: string;
  name: string;
  value_name?: string;
  value_id?: string;
  source: "ADS" | "preditor";
  reason: string;
}

const UNIT_MAP: Record<string, string[]> = {
  ML: ["mL", "ml", "cc"],
  L: ["L", "l"],
  G: ["g"],
  KG: ["kg"],
  MG: ["mg"],
};
const VOLUME_IDS = ["NET_VOLUME", "VOLUME", "UNIT_VOLUME", "CAPACITY"];
const WEIGHT_IDS = ["NET_WEIGHT", "UNIT_WEIGHT", "WEIGHT"];

export function suggestFromAds(
  product: { ean: string | null; presentation: string | null; rawPayload: unknown },
  attrs: MeliAttribute[],
  predictor: { id: string; name: string; valueId: string | null; valueName: string | null }[] = [],
): AttributeSuggestion[] {
  const byId = new Map(attrs.map((a) => [a.id, a]));
  const out: AttributeSuggestion[] = [];

  if (byId.has("GTIN") && isValidGtin(product.ean)) {
    out.push({ id: "GTIN", name: byId.get("GTIN")!.name, value_name: product.ean!, source: "ADS", reason: "EAN-13 da ADS com dígito verificador válido" });
  }
  const brand = (product.rawPayload as { marca?: unknown } | null)?.marca;
  if (byId.has("BRAND") && typeof brand === "string" && brand.trim()) {
    out.push({ id: "BRAND", name: byId.get("BRAND")!.name, value_name: brand.trim(), source: "ADS", reason: "Campo marca da ADS" });
  }

  const m = product.presentation?.trim().match(/^(\d+(?:[.,]\d+)?)\s*(ML|L|G|KG|MG)$/i);
  if (m) {
    const amount = m[1].replace(",", ".");
    const unit = m[2].toUpperCase();
    const ids = unit === "ML" || unit === "L" ? VOLUME_IDS : WEIGHT_IDS;
    for (const id of ids) {
      const a = byId.get(id);
      if (!a || a.value_type !== "number_unit" || a.tags?.read_only) continue;
      const allowed = (a.allowed_units ?? []).map((u) => u.id);
      const chosen = UNIT_MAP[unit].find((u) => allowed.includes(u));
      if (!chosen) continue;
      out.push({ id, name: a.name, value_name: `${amount} ${chosen}`, source: "ADS", reason: `Apresentação "${product.presentation}" da ADS` });
      break;
    }
  }

  for (const p of predictor) {
    const a = byId.get(p.id);
    if (!a || a.tags?.read_only || out.some((o) => o.id === p.id) || (!p.valueId && !p.valueName)) continue;
    out.push({ id: p.id, name: a.name, value_id: p.valueId ?? undefined, value_name: p.valueName ?? undefined, source: "preditor", reason: "Sugerido pelo preditor de categorias do Mercado Livre" });
  }
  return out;
}

export async function loadProductForSuggestions(sql: Sql, draftId: number) {
  const [row] = await sql.query<{ ean: string | null; presentation: string | null; rawPayload: unknown; name: string }>(
    `SELECT p.ean, p.presentation, p.raw_payload AS "rawPayload", COALESCE(p.name_custom, p.name_original) AS name
     FROM listing_drafts d JOIN products p ON p.id = d.product_id WHERE d.id = $1::int`,
    [draftId],
  );
  return row ?? null;
}
