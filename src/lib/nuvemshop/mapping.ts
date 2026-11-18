import "server-only";
import { isUniqueViolation, type Sql } from "../sql";
import type { Confidence, MatchSource } from "../stock/matching";

/**
 * NuvemshopProductMappingService — vincula variantes Nuvemshop a produtos ADS.
 *
 * A identidade central continua a do Inventory Core (products.id → ADS-<produtoId>). Critérios, do mais
 * forte para o mais fraco (mesmas regras do motor do Mercado Livre):
 *   1. EXISTING_LINK      vínculo já confirmado para o mesmo SKU (variante recriada na Nuvemshop ou SKU validado em pedidos ML);
 *   2. SKU_MATCH          SKU no padrão do integrador (ADS-<produtoId>) ou numérico igual ao produtoId ADS;
 *   3. GTIN_MATCH         barcode com dígito verificador válido igual ao EAN/DUN-14 do produto;
 *   4. MANUFACTURER_MATCH código do fabricante igual ao SKU/MPN (com marca compatível: média; sem marca: baixa);
 *   5. MANUAL             escolha do operador.
 * Título nunca gera vínculo. Mais de um produto no critério mais forte = ambíguo (escolha manual).
 * Sugestões não participam do Inventory Core; só vínculos CONFIRMED. Kits exigem composição formal.
 */
export class NuvemshopMappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NuvemshopMappingError";
  }
}

const norm = (expr: string) =>
  `regexp_replace(translate(upper(COALESCE(${expr}, '')), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC'), '[^A-Z0-9]', '', 'g')`;

const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const SOURCE_ORDER: MatchSource[] = ["EXISTING_LINK", "SKU_MATCH", "GTIN_MATCH", "MANUFACTURER_MATCH"];

export interface NsCandidate {
  productId: number;
  adsProductId: number;
  name: string;
  ean: string | null;
  manufacturerCode: string | null;
  brand: string | null;
  adsKit: boolean;
  source: MatchSource;
  confidence: Confidence;
  evidence: { source: MatchSource; confidence: Confidence; detail: string }[];
}

const CANDIDATES_SQL = `
WITH v AS (
  SELECT nv.store_id, nv.variant_id, nv.sku, nv.sku_norm, nv.gtin, nv.mpn, np.brand
  FROM nuvemshop_variants nv JOIN nuvemshop_products np ON np.store_id = nv.store_id AND np.product_id = nv.product_id
  WHERE nv.store_id = $1 AND nv.sync_status = 'ACTIVE' AND ($2::bigint[] IS NULL OR nv.variant_id = ANY($2::bigint[]))
), pb AS (
  SELECT id AS product_id, ltrim(regexp_replace(ean, '[^0-9]', '', 'g'), '0') AS code FROM products WHERE ean IS NOT NULL AND ean <> ''
  UNION SELECT id, ltrim(regexp_replace(dun14, '[^0-9]', '', 'g'), '0') FROM products WHERE dun14 IS NOT NULL AND dun14 <> ''
), pm AS (
  SELECT id AS product_id, ${norm("manufacturer_code")} AS code FROM products WHERE manufacturer_code IS NOT NULL
), c AS (
  -- 1. Vínculo já confirmado para o mesmo SKU: outra variante (removida/recriada) desta loja ou SKU validado em pedidos ML.
  SELECT v.variant_id, m.product_id, 'EXISTING_LINK' AS source, 'HIGH' AS confidence, 'SKU ' || v.sku || ' já vinculado à variante ' || m.variant_id AS detail
  FROM v JOIN nuvemshop_variants ov ON ov.store_id = v.store_id AND ov.variant_id <> v.variant_id AND ov.sku_norm = v.sku_norm AND ov.sync_status = 'REMOVED'
  JOIN nuvemshop_variant_mappings m ON m.store_id = ov.store_id AND m.variant_id = ov.variant_id AND m.status IN ('CONFIRMED', 'NEEDS_REVIEW')
  WHERE v.sku_norm IS NOT NULL
  UNION ALL
  SELECT v.variant_id, mm.product_id, 'EXISTING_LINK', 'HIGH', 'SKU ' || v.sku || ' já validado em pedidos do Mercado Livre'
  FROM v JOIN marketplace_product_mappings mm ON mm.active AND mm.mapping_type = 'SKU' AND upper(trim(mm.seller_sku)) = v.sku_norm
  UNION ALL
  -- 2. SKU no padrão do integrador ou numérico igual ao produtoId ADS.
  SELECT v.variant_id, p.id, 'SKU_MATCH', 'HIGH', 'SKU ' || v.sku || ' no padrão ADS-<produtoId>'
  FROM v JOIN products p ON v.sku_norm ~ '^ADS-[0-9]{1,9}$' AND p.ads_product_id = substring(v.sku_norm FROM 5)::int
  UNION ALL
  SELECT v.variant_id, p.id, 'SKU_MATCH', 'MEDIUM', 'SKU numérico ' || v.sku || ' igual ao produtoId ADS'
  FROM v JOIN products p ON v.sku_norm ~ '^[0-9]{1,9}$' AND p.ads_product_id = v.sku_norm::int
  UNION ALL
  -- 3. GTIN válido (o barcode só é guardado em gtin quando o dígito verificador confere).
  SELECT v.variant_id, pb.product_id, 'GTIN_MATCH', 'HIGH', 'GTIN ' || v.gtin
  FROM v JOIN pb ON pb.code = ltrim(v.gtin, '0') WHERE v.gtin IS NOT NULL
  UNION ALL
  -- 4. Código do fabricante igual ao SKU ou MPN (marca compatível com o fornecedor: média; sem marca: baixa).
  SELECT k.variant_id, pm.product_id, 'MANUFACTURER_MATCH',
         CASE WHEN v.brand IS NULL THEN 'LOW' ELSE 'MEDIUM' END,
         'Código do fabricante ' || p.manufacturer_code || CASE WHEN v.brand IS NULL THEN ' (marca não informada na Nuvemshop)' ELSE ' + marca ' || v.brand END
  FROM (SELECT DISTINCT variant_id, code FROM (
          SELECT v.variant_id, ${norm("v.mpn")} AS code FROM v
          UNION ALL SELECT v.variant_id, ${norm("v.sku")} FROM v) x WHERE length(code) >= 4) k
  JOIN pm ON pm.code = k.code
  JOIN v ON v.variant_id = k.variant_id
  JOIN products p ON p.id = pm.product_id
  LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
  WHERE v.brand IS NULL OR (s.id IS NOT NULL AND length(${norm("v.brand")}) >= 2 AND (
        ${norm("s.name")} LIKE '%' || ${norm("v.brand")} || '%'
     OR ${norm("s.trade_name")} LIKE '%' || ${norm("v.brand")} || '%'
     OR (length(${norm("s.trade_name")}) >= 3 AND ${norm("v.brand")} LIKE '%' || ${norm("s.trade_name")} || '%')))
)
SELECT c.variant_id::text AS "variantId", c.product_id AS "productId", p.ads_product_id AS "adsProductId",
       COALESCE(p.name_custom, p.name_original) AS name, p.ean, p.manufacturer_code AS "manufacturerCode",
       COALESCE(s.trade_name, s.name) AS brand, COALESCE(p.raw_payload->>'kit', 'false') = 'true' AS "adsKit",
       c.source, c.confidence, c.detail
FROM c JOIN products p ON p.id = c.product_id
LEFT JOIN ads_suppliers s ON s.id = p.supplier_id
WHERE NOT p.inactive
  AND NOT EXISTS (SELECT 1 FROM nuvemshop_variant_mappings x
                  WHERE x.store_id = $1 AND x.variant_id = c.variant_id AND x.product_id = c.product_id AND x.status = 'REJECTED')`;

interface CandidateRow {
  variantId: string;
  productId: number;
  adsProductId: number;
  name: string;
  ean: string | null;
  manufacturerCode: string | null;
  brand: string | null;
  adsKit: boolean;
  source: MatchSource;
  confidence: Confidence;
  detail: string;
}

/** Candidatos por variante, agrupados por produto e ordenados do mais forte para o mais fraco. */
export async function findNsCandidates(sql: Sql, storeId: string, variantIds: string[] | null): Promise<Map<string, NsCandidate[]>> {
  const rows = await sql.query<CandidateRow>(CANDIDATES_SQL, [storeId, variantIds]);
  const byVariant = new Map<string, Map<number, NsCandidate>>();
  for (const r of rows) {
    const m = byVariant.get(r.variantId) ?? new Map<number, NsCandidate>();
    byVariant.set(r.variantId, m);
    const c = m.get(r.productId) ?? {
      productId: r.productId,
      adsProductId: r.adsProductId,
      name: r.name,
      ean: r.ean,
      manufacturerCode: r.manufacturerCode,
      brand: r.brand,
      adsKit: r.adsKit,
      source: r.source,
      confidence: r.confidence,
      evidence: [],
    };
    if (!c.evidence.some((e) => e.source === r.source && e.detail === r.detail)) c.evidence.push({ source: r.source, confidence: r.confidence, detail: r.detail });
    const better = SOURCE_ORDER.indexOf(r.source) < SOURCE_ORDER.indexOf(c.source) || (r.source === c.source && RANK[r.confidence] > RANK[c.confidence]);
    if (better) {
      c.source = r.source;
      c.confidence = r.confidence;
    }
    m.set(r.productId, c);
  }
  const out = new Map<string, NsCandidate[]>();
  for (const [variantId, m] of byVariant) {
    out.set(
      variantId,
      [...m.values()].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || RANK[b.confidence] - RANK[a.confidence] || a.productId - b.productId),
    );
  }
  return out;
}

/** Os candidatos no nível mais forte (mesmo critério e confiança do primeiro). Mais de um = ambíguo. */
export function strongest(cands: NsCandidate[]): NsCandidate[] {
  if (!cands.length) return [];
  const top = cands[0];
  return cands.filter((c) => c.source === top.source && c.confidence === top.confidence);
}

async function history(tx: Sql, h: { storeId: string; variantId: string; mappingId: string | null; action: string; productId?: number | null; adsProductId?: number | null; actor: string; details?: unknown }) {
  await tx.execute(
    `INSERT INTO nuvemshop_mapping_history (store_id, variant_id, mapping_id, action, product_id, ads_product_id, actor, details) VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, $7, $8::jsonb)`,
    [h.storeId, h.variantId, h.mappingId, h.action, h.productId ?? null, h.adsProductId ?? null, h.actor, h.details === undefined ? null : JSON.stringify(h.details)],
  );
}

export interface RefreshResult {
  evaluated: number;
  suggested: number;
  ambiguous: number;
  needsReview: number;
}

/**
 * Recalcula sugestões e marca para revisão vínculos que perderam a base (variante removida ou SKU/GTIN
 * alterado). Nunca confirma nem remove vínculo sozinho.
 */
export async function refreshMappingSuggestions(sql: Sql, storeId: string, actor = "system:nuvemshop-matching", variantIds: string[] | null = null): Promise<RefreshResult> {
  // 1. Revisão: variante removida/recriada ou identificadores alterados desde a confirmação.
  const review = await sql.query<{ id: string; variantId: string; productId: number; adsProductId: number; reason: string }>(
    `UPDATE nuvemshop_variant_mappings m SET status = 'NEEDS_REVIEW', updated_at = now(),
       review_reason = CASE WHEN v.variant_id IS NULL OR v.sync_status = 'REMOVED' THEN 'Variante removida ou recriada na Nuvemshop'
                            WHEN m.sku_snapshot IS DISTINCT FROM v.sku_norm THEN 'SKU alterado na Nuvemshop desde a confirmação'
                            ELSE 'GTIN alterado na Nuvemshop desde a confirmação' END
     FROM nuvemshop_variant_mappings m0 LEFT JOIN nuvemshop_variants v ON v.store_id = m0.store_id AND v.variant_id = m0.variant_id
     WHERE m.id = m0.id AND m.store_id = $1 AND m.status = 'CONFIRMED'
       AND (v.variant_id IS NULL OR v.sync_status = 'REMOVED' OR m.sku_snapshot IS DISTINCT FROM v.sku_norm OR m.gtin_snapshot IS DISTINCT FROM v.gtin)
     RETURNING m.id::text AS id, m.variant_id::text AS "variantId", m.product_id AS "productId", m.ads_product_id AS "adsProductId", m.review_reason AS reason`,
    [storeId],
  );
  for (const r of review) {
    await history(sql, { storeId, variantId: r.variantId, mappingId: r.id, action: "NEEDS_REVIEW", productId: r.productId, adsProductId: r.adsProductId, actor, details: { reason: r.reason } });
  }

  // 2. Sugestões para variantes ativas sem vínculo vigente.
  const open = await sql.query<{ variantId: string; productId: string }>(
    `SELECT v.variant_id::text AS "variantId", v.product_id::text AS "productId" FROM nuvemshop_variants v
     WHERE v.store_id = $1 AND v.sync_status = 'ACTIVE' AND ($2::bigint[] IS NULL OR v.variant_id = ANY($2::bigint[]))
       AND NOT EXISTS (SELECT 1 FROM nuvemshop_variant_mappings m WHERE m.store_id = v.store_id AND m.variant_id = v.variant_id AND m.status IN ('CONFIRMED', 'NEEDS_REVIEW'))`,
    [storeId, variantIds],
  );
  const candidates = await findNsCandidates(sql, storeId, open.map((o) => o.variantId));
  let suggested = 0;
  let ambiguous = 0;
  for (const o of open) {
    const top = strongest(candidates.get(o.variantId) ?? []);
    if (top.length > 1) ambiguous++;
    const keep = top.map((c) => c.productId);
    await sql.execute(
      `UPDATE nuvemshop_variant_mappings SET status = 'SUPERSEDED', updated_at = now() WHERE store_id = $1 AND variant_id = $2::bigint AND status = 'SUGGESTED' AND NOT (product_id = ANY($3::int[]))`,
      [storeId, o.variantId, keep],
    );
    for (const c of top) {
      const [v] = await sql.query<{ skuNorm: string | null; gtin: string | null }>(`SELECT sku_norm AS "skuNorm", gtin FROM nuvemshop_variants WHERE store_id = $1 AND variant_id = $2::bigint`, [storeId, o.variantId]);
      const rows = await sql.query<{ id: string }>(
        `INSERT INTO nuvemshop_variant_mappings (store_id, nuvemshop_product_id, variant_id, product_id, ads_product_id, status, criterion, confidence, evidence, sku_snapshot, gtin_snapshot, created_by)
         VALUES ($1, $2::bigint, $3::bigint, $4, $5, 'SUGGESTED', $6, $7, $8::jsonb, $9, $10, $11)
         ON CONFLICT (store_id, variant_id, product_id) WHERE status = 'SUGGESTED' DO UPDATE SET criterion = EXCLUDED.criterion, confidence = EXCLUDED.confidence,
           evidence = EXCLUDED.evidence, sku_snapshot = EXCLUDED.sku_snapshot, gtin_snapshot = EXCLUDED.gtin_snapshot, updated_at = now()
         RETURNING id::text AS id, (xmax = 0) AS inserted`,
        [storeId, o.productId, o.variantId, c.productId, c.adsProductId, c.source, c.confidence, JSON.stringify(c.evidence), v?.skuNorm ?? null, v?.gtin ?? null, actor],
      );
      const inserted = (rows[0] as unknown as { inserted: boolean }).inserted;
      if (inserted) {
        suggested++;
        await history(sql, { storeId, variantId: o.variantId, mappingId: rows[0].id, action: "SUGGESTED", productId: c.productId, adsProductId: c.adsProductId, actor, details: { criterion: c.source, confidence: c.confidence, ambiguous: top.length > 1 } });
      }
    }
  }
  return { evaluated: open.length, suggested, ambiguous, needsReview: review.length };
}

export interface ComponentInput {
  productId: number;
  quantity: number;
}

interface VariantFacts {
  productId: string;
  status: string;
  skuNorm: string | null;
  gtin: string | null;
  nsKit: boolean;
}

async function variantFacts(tx: Sql, storeId: string, variantId: string): Promise<VariantFacts> {
  const [v] = await tx.query<VariantFacts>(
    `SELECT v.product_id::text AS "productId", v.sync_status AS status, v.sku_norm AS "skuNorm", v.gtin, p.is_kit AS "nsKit"
     FROM nuvemshop_variants v JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id
     WHERE v.store_id = $1 AND v.variant_id = $2::bigint`,
    [storeId, variantId],
  );
  if (!v) throw new NuvemshopMappingError("variant_not_found", "Variante não encontrada no catálogo importado");
  return v;
}

/**
 * Confirma (ou corrige) o vínculo de uma variante com um produto ADS. Kit (na Nuvemshop ou na ADS) exige
 * composição formal com pelo menos um componente. Corrigir para outro produto substitui o vínculo anterior,
 * com histórico.
 */
export async function confirmMapping(
  sql: Sql,
  input: { storeId: string; variantId: string; productId: number; actor: string; components?: ComponentInput[]; notes?: string | null; bulk?: boolean },
): Promise<{ mappingId: string; corrected: boolean }> {
  return sql.transaction(async (tx) => {
    const v = await variantFacts(tx, input.storeId, input.variantId);
    if (v.status !== "ACTIVE") throw new NuvemshopMappingError("variant_removed", "A variante foi removida na Nuvemshop: reimporte o catálogo antes de vincular");
    const [p] = await tx.query<{ id: number; adsProductId: number; inactive: boolean; kit: boolean }>(
      `SELECT id, ads_product_id AS "adsProductId", inactive, COALESCE(raw_payload->>'kit', 'false') = 'true' AS kit FROM products WHERE id = $1`,
      [input.productId],
    );
    if (!p) throw new NuvemshopMappingError("product_not_found", "Produto ADS não encontrado");
    if (p.inactive) throw new NuvemshopMappingError("product_inactive", "Produto ADS inativo: não pode ser vinculado");
    const components = (input.components ?? []).filter((c) => c.quantity > 0);
    if ((v.nsKit || p.kit) && !components.length) {
      throw new NuvemshopMappingError("kit_requires_components", "Kit: informe a composição (produtos ADS e quantidades por venda) — um kit não é vinculado a um SKU simples");
    }
    for (const c of components) {
      if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 1000) throw new NuvemshopMappingError("invalid_component", "Quantidade de componente inválida (1 a 1000)");
    }
    const compIds = [...new Set(components.map((c) => c.productId))];
    if (compIds.length !== components.length) throw new NuvemshopMappingError("invalid_component", "Componente repetido na composição");
    const compProducts = compIds.length
      ? await tx.query<{ id: number; adsProductId: number }>(`SELECT id, ads_product_id AS "adsProductId" FROM products WHERE id = ANY($1::int[]) AND NOT inactive`, [compIds])
      : [];
    if (compProducts.length !== compIds.length) throw new NuvemshopMappingError("invalid_component", "Componente inexistente ou inativo na ADS");

    const [current] = await tx.query<{ id: string; productId: number; status: string }>(
      `SELECT id::text AS id, product_id AS "productId", status FROM nuvemshop_variant_mappings WHERE store_id = $1 AND variant_id = $2::bigint AND status IN ('CONFIRMED', 'NEEDS_REVIEW') FOR UPDATE`,
      [input.storeId, input.variantId],
    );
    const [suggestion] = await tx.query<{ criterion: string; confidence: string; evidence: unknown }>(
      `SELECT criterion, confidence, evidence FROM nuvemshop_variant_mappings WHERE store_id = $1 AND variant_id = $2::bigint AND product_id = $3 AND status = 'SUGGESTED'`,
      [input.storeId, input.variantId, input.productId],
    );
    const corrected = Boolean(current && current.productId !== input.productId);
    if (current) {
      await tx.execute(`UPDATE nuvemshop_variant_mappings SET status = 'SUPERSEDED', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1::bigint`, [current.id, input.actor]);
    }
    await tx.execute(`UPDATE nuvemshop_variant_mappings SET status = 'SUPERSEDED', updated_at = now() WHERE store_id = $1 AND variant_id = $2::bigint AND status = 'SUGGESTED'`, [input.storeId, input.variantId]);
    let id: string;
    try {
      [{ id }] = await tx.query<{ id: string }>(
        `INSERT INTO nuvemshop_variant_mappings (store_id, nuvemshop_product_id, variant_id, product_id, ads_product_id, status, criterion, confidence, evidence,
           sku_snapshot, gtin_snapshot, created_by, decided_by, decided_at, notes)
         VALUES ($1, $2::bigint, $3::bigint, $4, $5, 'CONFIRMED', $6, $7, $8::jsonb, $9, $10, $11, $11, now(), $12) RETURNING id::text AS id`,
        [
          input.storeId,
          v.productId,
          input.variantId,
          p.id,
          p.adsProductId,
          suggestion?.criterion ?? "MANUAL",
          suggestion?.confidence ?? "MANUAL",
          JSON.stringify(suggestion?.evidence ?? []),
          v.skuNorm,
          v.gtin,
          input.actor,
          input.notes?.slice(0, 500) ?? null,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new NuvemshopMappingError("concurrent_change", "Outro administrador alterou este vínculo ao mesmo tempo. Recarregue a página.");
      throw err;
    }
    for (const c of components) {
      const cp = compProducts.find((x) => x.id === c.productId)!;
      await tx.execute(`INSERT INTO nuvemshop_mapping_components (mapping_id, product_id, ads_product_id, quantity) VALUES ($1::bigint, $2, $3, $4)`, [id, cp.id, cp.adsProductId, c.quantity]);
    }
    await history(tx, {
      storeId: input.storeId,
      variantId: input.variantId,
      mappingId: id,
      action: input.bulk ? "BULK_CONFIRMED" : corrected ? "CORRECTED" : "CONFIRMED",
      productId: p.id,
      adsProductId: p.adsProductId,
      actor: input.actor,
      details: { criterion: suggestion?.criterion ?? "MANUAL", previousProductId: current?.productId ?? null, previousStatus: current?.status ?? null, components },
    });
    return { mappingId: id, corrected };
  });
}

/** Recusa a sugestão de um produto para a variante (não volta a ser sugerido). */
export async function rejectSuggestion(sql: Sql, input: { storeId: string; variantId: string; productId: number; actor: string; reason?: string | null }): Promise<void> {
  await sql.transaction(async (tx) => {
    const v = await variantFacts(tx, input.storeId, input.variantId);
    const [p] = await tx.query<{ adsProductId: number }>(`SELECT ads_product_id AS "adsProductId" FROM products WHERE id = $1`, [input.productId]);
    if (!p) throw new NuvemshopMappingError("product_not_found", "Produto ADS não encontrado");
    const updated = await tx.query<{ id: string }>(
      `UPDATE nuvemshop_variant_mappings SET status = 'REJECTED', decided_by = $4, decided_at = now(), notes = $5, updated_at = now()
       WHERE store_id = $1 AND variant_id = $2::bigint AND product_id = $3 AND status = 'SUGGESTED' RETURNING id::text AS id`,
      [input.storeId, input.variantId, input.productId, input.actor, input.reason?.slice(0, 500) ?? null],
    );
    let id = updated[0]?.id ?? null;
    if (!id) {
      const already = await tx.query<{ id: string }>(`SELECT id::text AS id FROM nuvemshop_variant_mappings WHERE store_id = $1 AND variant_id = $2::bigint AND product_id = $3 AND status = 'REJECTED' LIMIT 1`, [
        input.storeId,
        input.variantId,
        input.productId,
      ]);
      if (already.length) return;
      [{ id }] = await tx.query<{ id: string }>(
        `INSERT INTO nuvemshop_variant_mappings (store_id, nuvemshop_product_id, variant_id, product_id, ads_product_id, status, criterion, confidence, created_by, decided_by, decided_at, notes)
         VALUES ($1, $2::bigint, $3::bigint, $4, $5, 'REJECTED', 'MANUAL', 'MANUAL', $6, $6, now(), $7) RETURNING id::text AS id`,
        [input.storeId, v.productId, input.variantId, input.productId, p.adsProductId, input.actor, input.reason?.slice(0, 500) ?? null],
      );
    }
    await history(tx, { storeId: input.storeId, variantId: input.variantId, mappingId: id, action: "REJECTED", productId: input.productId, adsProductId: p.adsProductId, actor: input.actor, details: { reason: input.reason ?? null } });
  });
}

/** Desvinculação controlada: exige motivo; o histórico preserva o vínculo anterior. */
export async function revokeMapping(sql: Sql, input: { storeId: string; variantId: string; actor: string; reason: string }): Promise<void> {
  if (!input.reason?.trim()) throw new NuvemshopMappingError("reason_required", "Informe o motivo da desvinculação");
  await sql.transaction(async (tx) => {
    const rows = await tx.query<{ id: string; productId: number; adsProductId: number }>(
      `UPDATE nuvemshop_variant_mappings SET status = 'REVOKED', decided_by = $3, decided_at = now(), notes = $4, updated_at = now()
       WHERE store_id = $1 AND variant_id = $2::bigint AND status IN ('CONFIRMED', 'NEEDS_REVIEW') RETURNING id::text AS id, product_id AS "productId", ads_product_id AS "adsProductId"`,
      [input.storeId, input.variantId, input.actor, input.reason.slice(0, 500)],
    );
    if (!rows.length) throw new NuvemshopMappingError("not_linked", "Esta variante não tem vínculo vigente");
    await history(tx, { storeId: input.storeId, variantId: input.variantId, mappingId: rows[0].id, action: "REVOKED", productId: rows[0].productId, adsProductId: rows[0].adsProductId, actor: input.actor, details: { reason: input.reason } });
  });
}

export interface BulkResult {
  confirmed: number;
  skipped: { variantId: string; reason: string }[];
}

/**
 * Confirmação em lote SOMENTE de correspondências seguras: sugestão única, de confiança alta, por vínculo
 * existente, SKU no padrão ADS ou GTIN válido; sem kit; sem SKU/GTIN duplicado na loja.
 */
export async function bulkConfirmSafe(sql: Sql, input: { storeId: string; actor: string; variantIds: string[] }): Promise<BulkResult> {
  const ids = [...new Set(input.variantIds)].slice(0, 500);
  const rows = await sql.query<{ variantId: string; productId: number; criterion: string; confidence: string; suggestions: number; dupSku: boolean; dupGtin: boolean; nsKit: boolean; adsKit: boolean; linked: boolean }>(
    `SELECT v.variant_id::text AS "variantId", s.product_id AS "productId", s.criterion, s.confidence,
            (SELECT count(*)::int FROM nuvemshop_variant_mappings x WHERE x.store_id = v.store_id AND x.variant_id = v.variant_id AND x.status = 'SUGGESTED') AS suggestions,
            (v.sku_norm IS NOT NULL AND EXISTS (SELECT 1 FROM nuvemshop_variants d WHERE d.store_id = v.store_id AND d.sku_norm = v.sku_norm AND d.variant_id <> v.variant_id AND d.sync_status = 'ACTIVE')) AS "dupSku",
            (v.gtin IS NOT NULL AND EXISTS (SELECT 1 FROM nuvemshop_variants d WHERE d.store_id = v.store_id AND d.gtin = v.gtin AND d.variant_id <> v.variant_id AND d.sync_status = 'ACTIVE')) AS "dupGtin",
            np.is_kit AS "nsKit", COALESCE(p.raw_payload->>'kit', 'false') = 'true' AS "adsKit",
            EXISTS (SELECT 1 FROM nuvemshop_variant_mappings c WHERE c.store_id = v.store_id AND c.variant_id = v.variant_id AND c.status IN ('CONFIRMED', 'NEEDS_REVIEW')) AS linked
     FROM nuvemshop_variants v
     JOIN nuvemshop_products np ON np.store_id = v.store_id AND np.product_id = v.product_id
     LEFT JOIN nuvemshop_variant_mappings s ON s.store_id = v.store_id AND s.variant_id = v.variant_id AND s.status = 'SUGGESTED'
     LEFT JOIN products p ON p.id = s.product_id
     WHERE v.store_id = $1 AND v.variant_id = ANY($2::bigint[]) AND v.sync_status = 'ACTIVE'`,
    [input.storeId, ids],
  );
  const result: BulkResult = { confirmed: 0, skipped: [] };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.variantId)) continue;
    seen.add(r.variantId);
    const reason =
      r.linked ? "já vinculada"
      : !r.productId ? "sem sugestão"
      : r.suggestions > 1 ? "correspondência ambígua"
      : r.confidence !== "HIGH" || !["EXISTING_LINK", "SKU_MATCH", "GTIN_MATCH"].includes(r.criterion) ? "sugestão sem confiança alta"
      : r.dupSku ? "SKU duplicado na loja"
      : r.dupGtin ? "GTIN duplicado na loja"
      : r.nsKit || r.adsKit ? "kit exige composição manual"
      : null;
    if (reason) {
      result.skipped.push({ variantId: r.variantId, reason });
      continue;
    }
    try {
      await confirmMapping(sql, { storeId: input.storeId, variantId: r.variantId, productId: r.productId, actor: input.actor, bulk: true });
      result.confirmed++;
    } catch (err) {
      result.skipped.push({ variantId: r.variantId, reason: err instanceof NuvemshopMappingError ? err.message : "erro ao confirmar" });
    }
  }
  for (const id of ids) if (!seen.has(id)) result.skipped.push({ variantId: id, reason: "variante não encontrada ou removida" });
  return result;
}

export async function mappingHistory(sql: Sql, storeId: string, variantId: string) {
  return sql.query<{ id: string; action: string; productId: number | null; adsProductId: number | null; actor: string; details: unknown; createdAt: Date }>(
    `SELECT id::text AS id, action, product_id AS "productId", ads_product_id AS "adsProductId", actor, details, created_at AS "createdAt"
     FROM nuvemshop_mapping_history WHERE store_id = $1 AND variant_id = $2::bigint ORDER BY id DESC LIMIT 100`,
    [storeId, variantId],
  );
}
