import "server-only";
import { MappingError, remapOrders, saveMapping } from "../marketplace/mappings";
import type { Sql } from "../sql";
import { findCandidates, refreshSuggestions, titleHints, type Candidate } from "./matching";
import { recordHistory, StockSyncError } from "./settings";

/**
 * Vínculo anúncio legado → produto ADS. Reutiliza marketplace_product_mappings (tipo ITEM), o mesmo
 * vínculo usado pelos pedidos: confirmar aqui também passa a mapear os pedidos desse anúncio.
 * Anúncios publicados pelo integrador já estão vinculados pela publicação (EXISTING_LINK) e não mudam aqui.
 */
export interface LegacyRef {
  id: string;
  itemId: string;
  variationId: string;
  title: string | null;
  itemHasVariations: boolean;
  integratorProductId: number | null;
  mappingId: string | null;
  mappingProductId: number | null;
}

export async function getRef(sql: Sql, id: string): Promise<LegacyRef> {
  if (!/^\d{1,18}$/.test(id)) throw new StockSyncError("not_found", "Anúncio não encontrado", 404);
  const [r] = await sql.query<LegacyRef>(
    `SELECT ll.id::text AS id, ll.marketplace_item_id AS "itemId", ll.variation_id AS "variationId", ll.title, ll.item_has_variations AS "itemHasVariations",
            (SELECT l.product_id FROM marketplace_listings l WHERE l.marketplace_item_id = ll.marketplace_item_id AND l.status <> 'deleted' ORDER BY l.id DESC LIMIT 1) AS "integratorProductId",
            m.id::text AS "mappingId", m.product_id AS "mappingProductId"
     FROM legacy_listings ll
     LEFT JOIN marketplace_product_mappings m ON m.active AND m.mapping_type = 'ITEM' AND m.marketplace_item_id = ll.marketplace_item_id AND m.variation_id = ll.variation_id
     WHERE ll.id = $1::bigint AND ll.removed_at IS NULL`,
    [id],
  );
  if (!r) throw new StockSyncError("not_found", "Anúncio não encontrado no inventário (atualize a lista de anúncios)", 404);
  return r;
}

export interface CandidatesResult {
  link: { source: "EXISTING_LINK" | "MAPPING"; productId: number } | null;
  candidates: Candidate[];
  /** Apenas auxílio visual: nunca selecionado automaticamente. */
  titleHints: { productId: number; adsProductId: number; name: string }[];
  ambiguous: boolean;
}

export async function getCandidates(sql: Sql, id: string): Promise<CandidatesResult> {
  const ref = await getRef(sql, id);
  const candidates = (await findCandidates(sql, [id])).get(id) ?? [];
  const hints = (await titleHints(sql, ref.title)).filter((h) => !candidates.some((c) => c.productId === h.productId));
  const link = ref.integratorProductId
    ? { source: "EXISTING_LINK" as const, productId: ref.integratorProductId }
    : ref.mappingProductId
      ? { source: "MAPPING" as const, productId: ref.mappingProductId }
      : null;
  return { link, candidates, titleHints: hints, ambiguous: candidates.length > 1 };
}

export interface ConfirmInput {
  productId: number;
  components?: { productId: number; quantity: number }[];
  maxQuantity?: number | null;
  notes?: string | null;
  /** Substitui um vínculo confirmado anteriormente para outro produto. */
  replace?: boolean;
  /** false = não reaplica nos pedidos agora (lote). */
  remap?: boolean;
}

export async function confirmLink(sql: Sql, id: string, input: ConfirmInput, actor: string): Promise<{ mappingId: string | null; source: string }> {
  const ref = await getRef(sql, id);
  if (ref.integratorProductId) throw new StockSyncError("published_link", "Anúncio publicado pelo integrador: o vínculo vem da publicação e não pode ser alterado aqui");
  const [product] = await sql.query<{ kit: boolean }>(`SELECT COALESCE(raw_payload->>'kit', 'false') = 'true' AS kit FROM products WHERE id = $1::int`, [input.productId]);
  if (!product) throw new StockSyncError("product_not_found", "Produto ADS não encontrado", 404);
  const components = input.components?.length ? input.components : undefined;
  if (components) {
    const ids = components.map((c) => c.productId);
    if (new Set(ids).size !== ids.length) throw new StockSyncError("invalid_components", "Componente repetido na composição", 422);
  }
  if (product.kit && !components) throw new StockSyncError("kit_composition_required", "Produto marcado como kit na ADS: informe a composição (produtos e quantidades) antes de vincular", 422);
  // A origem do critério é recalculada no servidor: só vale se o motor encontra este produto por esse critério.
  const candidates = (await findCandidates(sql, [id])).get(id) ?? [];
  const match = candidates.find((c) => c.productId === input.productId);
  const source = match && match.source !== "EXISTING_LINK" ? match.source : "MANUAL";
  try {
    const r = await saveMapping(sql, {
      scope: "ITEM",
      itemId: ref.itemId,
      variationId: ref.variationId || null,
      productId: input.productId,
      createdBy: actor,
      notes: input.notes ?? null,
      replace: input.replace,
      remap: input.remap,
      source,
      components,
      maxQuantity: input.maxQuantity ?? null,
    });
    // Propostas calculadas com o vínculo anterior deixam de valer.
    await supersedeProposals(sql, ref.itemId);
    await recordHistory(sql, {
      type: "link_confirmed",
      actor,
      itemId: ref.itemId,
      variationId: ref.variationId,
      productId: input.productId,
      mappingId: r.mappingId,
      details: { source, components: components ?? null, maxQuantity: input.maxQuantity ?? null, candidates: candidates.length, replaced: ref.mappingProductId },
    });
    return { mappingId: r.mappingId, source };
  } catch (err) {
    if (err instanceof MappingError) throw new StockSyncError(err.code, err.message);
    throw err;
  }
}

async function supersedeProposals(sql: Sql, itemId: string): Promise<void> {
  await sql.execute(
    `UPDATE stock_sync_proposals SET status = 'SUPERSEDED' WHERE status IN ('PROPOSED', 'APPROVED') AND $1::text = ANY(marketplace_item_ids)`,
    [itemId],
  );
}

export async function removeLink(sql: Sql, id: string, actor: string): Promise<boolean> {
  const ref = await getRef(sql, id);
  if (ref.integratorProductId) throw new StockSyncError("published_link", "Anúncio publicado pelo integrador: o vínculo vem da publicação e não pode ser removido aqui");
  if (!ref.mappingId) return false;
  const n = await sql.execute(
    `UPDATE marketplace_product_mappings SET active = false, deactivated_at = now(), deactivated_by = $2::text WHERE id = $1::bigint AND active`,
    [ref.mappingId, actor],
  );
  if (!n) return false;
  await supersedeProposals(sql, ref.itemId);
  await recordHistory(sql, { type: "link_removed", actor, itemId: ref.itemId, variationId: ref.variationId, productId: ref.mappingProductId, mappingId: ref.mappingId });
  return true;
}

export async function rejectSuggestion(sql: Sql, id: string, productId: number, actor: string): Promise<void> {
  const ref = await getRef(sql, id);
  await sql.execute(
    `INSERT INTO legacy_listing_rejections (marketplace_item_id, variation_id, product_id, rejected_by) VALUES ($1::text, $2::text, $3::int, $4::text)
     ON CONFLICT (marketplace_item_id, variation_id, product_id) DO NOTHING`,
    [ref.itemId, ref.variationId, productId, actor],
  );
  await refreshSuggestions(sql, [id]);
  await recordHistory(sql, { type: "suggestion_rejected", actor, itemId: ref.itemId, variationId: ref.variationId, productId });
}

/**
 * Vinculação em lote: somente correspondências inequívocas (um único candidato, por SKU ou GTIN, confiança alta,
 * produto que não é kit) e somente para o produto que o operador viu e confirmou na tela.
 */
export async function confirmBatch(
  sql: Sql,
  items: { id: string; productId: number }[],
  actor: string,
): Promise<{ linked: { id: string; mappingId: string | null }[]; skipped: { id: string; reason: string }[]; remapped: { lines: number; mapped: number; orders: number } }> {
  const linked: { id: string; mappingId: string | null }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const cands = await findCandidates(
    sql,
    items.map((i) => i.id),
  );
  for (const it of items) {
    try {
      const ref = await getRef(sql, it.id);
      if (ref.integratorProductId || ref.mappingId) {
        skipped.push({ id: it.id, reason: "Já vinculado" });
        continue;
      }
      const list = cands.get(it.id) ?? [];
      if (list.length !== 1) {
        skipped.push({ id: it.id, reason: list.length ? "Correspondência ambígua: escolha manual" : "Sem correspondência" });
        continue;
      }
      const c = list[0];
      if (c.productId !== it.productId) {
        skipped.push({ id: it.id, reason: "A sugestão mudou desde que a tela foi carregada" });
        continue;
      }
      if (!(c.source === "SKU_MATCH" || c.source === "GTIN_MATCH") || c.confidence !== "HIGH") {
        skipped.push({ id: it.id, reason: "Critério insuficiente para lote (exige SKU ou GTIN com confiança alta)" });
        continue;
      }
      if (c.kit) {
        skipped.push({ id: it.id, reason: "Produto kit: informe a composição individualmente" });
        continue;
      }
      const r = await confirmLink(sql, it.id, { productId: it.productId, remap: false }, actor);
      linked.push({ id: it.id, mappingId: r.mappingId });
    } catch (err) {
      skipped.push({ id: it.id, reason: err instanceof Error ? err.message.slice(0, 200) : "Erro" });
    }
  }
  const remapped = linked.length ? await remapOrders(sql) : { lines: 0, mapped: 0, orders: 0 };
  return { linked, skipped, remapped };
}
