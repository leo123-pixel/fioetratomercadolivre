import "server-only";
import type { Sql } from "../sql";

/**
 * Motor de correspondência anúncio do Mercado Livre → produto ADS. Só SUGERE: o vínculo é sempre
 * confirmado pelo operador. Prioridade (da mais forte para a mais fraca):
 *   1. EXISTING_LINK      — vínculo interno já validado (publicação pelo integrador ou vínculo confirmado);
 *   2. SKU_MATCH          — SKU originado da ADS ("ADS-<produtoId>"), SKU já validado em pedidos, ou SKU numérico = produtoId;
 *   3. GTIN_MATCH         — GTIN/EAN com dígito verificador válido igual ao EAN/DUN-14 do produto;
 *   4. MANUFACTURER_MATCH — código do fabricante igual, com marca compatível (sem marca no anúncio: confiança baixa);
 *   5. título             — apenas dica visual (nunca vira sugestão nem vínculo).
 * Vários produtos candidatos = correspondência ambígua (escolha manual obrigatória).
 */
export type MatchSource = "EXISTING_LINK" | "SKU_MATCH" | "GTIN_MATCH" | "MANUFACTURER_MATCH";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface CandidateEvidence {
  source: MatchSource;
  confidence: Confidence;
  detail: string;
}

export interface Candidate {
  productId: number;
  adsProductId: number;
  name: string;
  ean: string | null;
  manufacturerCode: string | null;
  brand: string | null;
  /** Produto marcado como kit na ADS: o vínculo exige a composição. */
  kit: boolean;
  evidence: CandidateEvidence[];
  /** Critério mais forte. */
  source: MatchSource;
  confidence: Confidence;
}

/** GTIN-8/12/13/14 com dígito verificador válido. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  if (/^0+$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** Extrai GTINs válidos de um texto (o ML pode trazer vários separados por vírgula). */
export function extractGtins(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    for (const part of String(v ?? "").split(/[,;\s]+/)) {
      const d = part.replace(/\D/g, "");
      if (isValidGtin(d)) out.add(d);
    }
  }
  return [...out];
}

/** Normaliza texto para comparação de códigos e marcas (maiúsculas, sem acento, só A-Z0-9). */
const norm = (expr: string) =>
  `regexp_replace(translate(upper(COALESCE(${expr}, '')), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC'), '[^A-Z0-9]', '', 'g')`;

export const CANDIDATES_SQL = `
WITH r AS (
  SELECT id, marketplace_item_id, variation_id, seller_sku, gtins, brand, manufacturer_code
  FROM legacy_listings WHERE id = ANY($1::bigint[])
), pb AS (
  -- Códigos de barras normalizados (sem zeros à esquerda) para junção por igualdade.
  SELECT id AS product_id, ltrim(ean, '0') AS code FROM products WHERE ean IS NOT NULL AND ean <> ''
  UNION SELECT id, ltrim(dun14, '0') FROM products WHERE dun14 IS NOT NULL AND dun14 <> ''
), pm AS (
  SELECT id AS product_id, ${norm("manufacturer_code")} AS code FROM products WHERE manufacturer_code IS NOT NULL
), c AS (
  SELECT r.id AS row_id, p.id AS product_id, 'SKU_MATCH' AS source, 'HIGH' AS confidence, 'SKU ' || r.seller_sku || ' gerado pela ADS/integrador' AS detail
  FROM r JOIN products p ON r.seller_sku ~ '^ADS-[0-9]{1,9}$' AND p.ads_product_id = substring(r.seller_sku FROM 5)::int
  UNION ALL
  SELECT r.id, m.product_id, 'SKU_MATCH', 'HIGH', 'SKU ' || r.seller_sku || ' já validado em pedidos'
  FROM r JOIN marketplace_product_mappings m ON m.active AND m.mapping_type = 'SKU' AND m.seller_sku = r.seller_sku
  UNION ALL
  SELECT r.id, p.id, 'SKU_MATCH', 'MEDIUM', 'SKU numérico ' || r.seller_sku || ' igual ao produtoId ADS'
  FROM r JOIN products p ON r.seller_sku ~ '^[0-9]{1,9}$' AND p.ads_product_id = r.seller_sku::int
  UNION ALL
  SELECT r.id, pb.product_id, 'GTIN_MATCH', 'HIGH', 'GTIN ' || g
  FROM r CROSS JOIN LATERAL unnest(r.gtins) AS g
  JOIN pb ON pb.code = ltrim(g, '0')
  UNION ALL
  SELECT k.row_id, pm.product_id, 'MANUFACTURER_MATCH',
         CASE WHEN r.brand IS NULL THEN 'LOW' ELSE 'MEDIUM' END,
         'Código do fabricante ' || p.manufacturer_code || CASE WHEN r.brand IS NULL THEN ' (marca não informada no anúncio)' ELSE ' + marca ' || r.brand END
  FROM (SELECT DISTINCT row_id, code FROM (
          SELECT r.id AS row_id, ${norm("r.manufacturer_code")} AS code FROM r
          UNION ALL SELECT r.id, ${norm("r.seller_sku")} FROM r) x WHERE length(code) >= 4) k
  JOIN pm ON pm.code = k.code
  JOIN r ON r.id = k.row_id
  JOIN products p ON p.id = pm.product_id
  LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
  WHERE r.brand IS NULL OR (s.id IS NOT NULL AND length(${norm("r.brand")}) >= 2 AND (
        ${norm("s.name")} LIKE '%' || ${norm("r.brand")} || '%'
     OR ${norm("s.trade_name")} LIKE '%' || ${norm("r.brand")} || '%'
     OR (length(${norm("s.trade_name")}) >= 3 AND ${norm("r.brand")} LIKE '%' || ${norm("s.trade_name")} || '%')))
)
SELECT c.row_id::text AS "rowId", c.product_id AS "productId", p.ads_product_id AS "adsProductId",
       COALESCE(p.name_custom, p.name_original) AS name, p.ean, p.manufacturer_code AS "manufacturerCode",
       COALESCE(s.trade_name, s.name) AS brand, COALESCE(p.raw_payload->>'kit', 'false') = 'true' AS kit,
       c.source, c.confidence, c.detail
FROM c JOIN products p ON p.id = c.product_id
LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
JOIN r ON r.id = c.row_id
WHERE NOT p.inactive
  AND NOT EXISTS (SELECT 1 FROM legacy_listing_rejections x
                  WHERE x.marketplace_item_id = r.marketplace_item_id AND x.variation_id = r.variation_id AND x.product_id = c.product_id)`;

interface CandidateRow {
  rowId: string;
  productId: number;
  adsProductId: number;
  name: string;
  ean: string | null;
  manufacturerCode: string | null;
  brand: string | null;
  kit: boolean;
  source: MatchSource;
  confidence: Confidence;
  detail: string;
}

const SOURCE_ORDER: MatchSource[] = ["EXISTING_LINK", "SKU_MATCH", "GTIN_MATCH", "MANUFACTURER_MATCH"];

/** Candidatos por linha do inventário, agrupados por produto e ordenados do mais forte para o mais fraco. */
export async function findCandidates(sql: Sql, rowIds: string[]): Promise<Map<string, Candidate[]>> {
  const out = new Map<string, Candidate[]>();
  if (!rowIds.length) return out;
  const rows = await sql.query<CandidateRow>(CANDIDATES_SQL, [rowIds]);
  const byRow = new Map<string, Map<number, Candidate>>();
  for (const r of rows) {
    const products = byRow.get(r.rowId) ?? new Map<number, Candidate>();
    byRow.set(r.rowId, products);
    const c = products.get(r.productId) ?? {
      productId: r.productId,
      adsProductId: r.adsProductId,
      name: r.name,
      ean: r.ean,
      manufacturerCode: r.manufacturerCode,
      brand: r.brand,
      kit: r.kit,
      evidence: [],
      source: r.source,
      confidence: r.confidence,
    };
    if (!c.evidence.some((e) => e.source === r.source && e.detail === r.detail)) c.evidence.push({ source: r.source, confidence: r.confidence, detail: r.detail });
    products.set(r.productId, c);
  }
  for (const [rowId, products] of byRow) {
    const list = [...products.values()].map((c) => {
      const best = [...c.evidence].sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))[0];
      const distinctSources = new Set(c.evidence.map((e) => e.source)).size;
      // Critérios independentes concordando elevam a confiança.
      const confidence: Confidence = distinctSources >= 2 && best.confidence !== "HIGH" ? (best.confidence === "LOW" ? "MEDIUM" : "HIGH") : best.confidence;
      return { ...c, source: best.source, confidence };
    });
    list.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.adsProductId - b.adsProductId);
    out.set(rowId, list);
  }
  return out;
}

/** Dica visual por título (NUNCA usada como sugestão ou vínculo automático). */
export async function titleHints(sql: Sql, title: string | null): Promise<{ productId: number; adsProductId: number; name: string }[]> {
  const words = [
    ...new Set(
      (title ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (words.length < 2) return [];
  const pattern = (w: string) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  for (const take of [words.length, 2]) {
    const ws = words.slice(0, take).map(pattern);
    const rows = await sql.query<{ productId: number; adsProductId: number; name: string }>(
      `SELECT id AS "productId", ads_product_id AS "adsProductId", COALESCE(name_custom, name_original) AS name FROM products
       WHERE NOT inactive AND (SELECT bool_and(translate(lower(COALESCE(name_custom, name_original)), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') LIKE w) FROM unnest($1::text[]) AS w)
       ORDER BY ads_product_id LIMIT 5`,
      [ws],
    );
    if (rows.length) return rows;
  }
  return [];
}

/**
 * Recalcula e grava as sugestões das linhas indicadas (ou de todas as vigentes). Não cria vínculos.
 * Linhas já vinculadas também são avaliadas: um candidato forte diferente do vínculo aparece como alerta.
 */
export async function refreshSuggestions(sql: Sql, rowIds?: string[]): Promise<{ evaluated: number; suggested: number; ambiguous: number }> {
  const ids =
    rowIds ??
    (await sql.query<{ id: string }>(`SELECT id::text AS id FROM legacy_listings WHERE removed_at IS NULL ORDER BY id`)).map((r) => r.id);
  let suggested = 0;
  let ambiguous = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const cands = await findCandidates(sql, chunk);
    const updates = chunk.map((id) => {
      const list = cands.get(id) ?? [];
      if (list.length === 1) suggested++;
      if (list.length > 1) ambiguous++;
      const top = list.length === 1 ? list[0] : null;
      return {
        id: Number(id),
        product_id: top?.productId ?? null,
        source: top?.source ?? null,
        confidence: top?.confidence ?? null,
        count: list.length,
        details: list.length ? list.slice(0, 10).map((c) => ({ productId: c.productId, adsProductId: c.adsProductId, name: c.name, source: c.source, confidence: c.confidence, kit: c.kit, evidence: c.evidence })) : null,
      };
    });
    await sql.execute(
      `UPDATE legacy_listings l SET suggested_product_id = u.product_id, suggestion_source = u.source, suggestion_confidence = u.confidence,
         candidate_count = u.count, suggestion_details = u.details, suggested_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, product_id int, source text, confidence text, count int, details jsonb)
       WHERE l.id = u.id`,
      [JSON.stringify(updates)],
    );
  }
  return { evaluated: ids.length, suggested, ambiguous };
}
