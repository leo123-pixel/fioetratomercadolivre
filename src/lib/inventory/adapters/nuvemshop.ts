import "server-only";
import type { Sql } from "../../sql";
import { assertRemoteWriteAllowed } from "../mode";
import type { CapabilityResult, ChannelListingInventory, ChannelMapping, InventoryChannelAdapter, PreparedStockUpdate, VerifyResult } from "./types";

/**
 * Nuvemshop no Inventory Core.
 *
 * NuvemshopSimulatedAdapter — usado enquanto nenhuma loja está conectada: nada é lido nem escrito.
 *
 * NuvemshopInventoryAdapter (Fase 1) — SOMENTE LEITURA, a partir do catálogo importado (tabelas
 * nuvemshop_*, atualizadas pela importação em GET). Não faz chamada de rede nem escrita: applyStockUpdate
 * continua recusado pelo portão do Inventory Core. Só vínculos CONFIRMED (variante ↔ produto ADS) entram;
 * o estoque observado de cada variante é o das localizações associadas ao depósito do canal
 * (associação configurável Location Nuvemshop ↔ depósito; nunca presumida). Estoque em localização não
 * associada, não controlado (ilimitado) ou ausente = DESCONHECIDO (nunca vira zero).
 */
export class NuvemshopSimulatedAdapter implements InventoryChannelAdapter {
  readonly channel = "nuvemshop";
  readonly displayName = "Nuvemshop (simulado)";
  readonly simulated = true;

  async getChannelInventory(): Promise<ChannelListingInventory[]> {
    return [];
  }

  async getProductMappings(): Promise<ChannelMapping[]> {
    return [];
  }

  validateInventoryCapability(): CapabilityResult {
    return { managedByAds: true, writableByApi: false, code: "NOT_INTEGRATED", reason: "Canal ainda não integrado (simulação)" };
  }

  prepareStockUpdate(listing: ChannelListingInventory, target: number): PreparedStockUpdate {
    return { channel: this.channel, key: listing.key, current: listing.announced, target, operation: `Simulação: estoque ${listing.key} → ${target}`, simulated: true };
  }

  async applyStockUpdate(update: PreparedStockUpdate): Promise<never> {
    return assertRemoteWriteAllowed(`Nuvemshop ${update.key} → ${update.target}`);
  }

  async verifyStockUpdate(update: PreparedStockUpdate): Promise<VerifyResult> {
    return { key: update.key, observed: null, matches: false, readAt: new Date() };
  }
}

export interface NsLocationInfo {
  locationId: string;
  name: string | null;
  isDefault: boolean | null;
  priority: number | null;
  removed: boolean;
  mappingStatus: "UNMAPPED" | "MAPPED" | "EXCLUDED";
  warehouseCode: string | null;
}

export interface NsVariantStock {
  key: string;
  storeId: string;
  variantId: string;
  productId: string;
  title: string | null;
  sku: string | null;
  stockManagement: boolean | null;
  /** Estoque legado total (todas as localizações). */
  totalStock: number | null;
  /** Estoque por localização (inventory_levels, ou o total atribuído à localização padrão quando a loja não usa múltiplos locais). */
  levels: { locationId: string; stock: number | null; mappingStatus: string; warehouseCode: string | null }[];
  /** Quantidade observada nas localizações do depósito do canal (null = desconhecida). */
  observed: number | null;
  observedReason: string | null;
  status: "active" | "paused" | "closed";
  readAt: Date | null;
}

export interface NsConnectionState {
  connected: boolean;
  storeId: string | null;
  imported: boolean;
}

export class NuvemshopInventoryAdapter implements InventoryChannelAdapter {
  readonly channel = "nuvemshop";
  readonly displayName = "Nuvemshop";
  /** Lido de verdade; as cotas continuam simuladas porque não existe caminho de escrita (Fase 1). */
  readonly simulated = false;

  constructor(
    private readonly sql: Sql,
    /** Depósito do Inventory Core em que a Nuvemshop vende (configurável no Inventory Core). */
    private readonly warehouse: string,
  ) {}

  async state(): Promise<NsConnectionState> {
    const [s] = await this.sql.query<{ storeId: string; imported: boolean }>(
      `SELECT s.store_id AS "storeId", EXISTS (SELECT 1 FROM nuvemshop_variants v WHERE v.store_id = s.store_id) AS imported
       FROM nuvemshop_stores s WHERE s.connection_status <> 'DISCONNECTED' ORDER BY s.updated_at DESC LIMIT 1`,
    );
    return { connected: Boolean(s), storeId: s?.storeId ?? null, imported: s?.imported ?? false };
  }

  async getLocations(): Promise<NsLocationInfo[]> {
    const st = await this.state();
    if (!st.storeId) return [];
    return this.sql.query<NsLocationInfo>(
      `SELECT location_id AS "locationId", name, is_default AS "isDefault", priority, (removed_at IS NOT NULL) AS removed,
              mapping_status AS "mappingStatus", warehouse_code AS "warehouseCode"
       FROM nuvemshop_locations WHERE store_id = $1 ORDER BY removed_at NULLS FIRST, priority NULLS LAST, location_id`,
      [st.storeId],
    );
  }

  /** Estoque observado por variante vinculada (ou por todas, com allVariants), sem rede. */
  async getInventorySnapshot(opts: { allVariants?: boolean; variantIds?: string[] } = {}): Promise<NsVariantStock[]> {
    const st = await this.state();
    if (!st.storeId) return [];
    const locations = await this.getLocations();
    const active = locations.filter((l) => !l.removed);
    const fallback = active.find((l) => l.isDefault) ?? (active.length === 1 ? active[0] : null);
    const rows = await this.sql.query<{
      variantId: string;
      productId: string;
      title: string | null;
      sku: string | null;
      stockManagement: boolean | null;
      stock: number | null;
      hasLevels: boolean;
      visible: boolean | null;
      visibility: string | null;
      productStatus: string;
      variantStatus: string;
      fetchedAt: Date;
      levels: { locationId: string; stock: number | null }[] | null;
    }>(
      `SELECT v.variant_id::text AS "variantId", v.product_id::text AS "productId", p.name AS title, v.sku, v.stock_management AS "stockManagement", v.stock,
              v.has_inventory_levels AS "hasLevels", v.visible, p.visibility, p.sync_status AS "productStatus", v.sync_status AS "variantStatus", v.fetched_at AS "fetchedAt",
              (SELECT json_agg(json_build_object('locationId', l.location_id, 'stock', l.stock)) FROM nuvemshop_inventory_levels l WHERE l.store_id = v.store_id AND l.variant_id = v.variant_id) AS levels
       FROM nuvemshop_variants v JOIN nuvemshop_products p ON p.store_id = v.store_id AND p.product_id = v.product_id
       WHERE v.store_id = $1 AND ($2::boolean OR EXISTS (SELECT 1 FROM nuvemshop_variant_mappings m WHERE m.store_id = v.store_id AND m.variant_id = v.variant_id AND m.status IN ('CONFIRMED', 'NEEDS_REVIEW')))
         AND ($3::bigint[] IS NULL OR v.variant_id = ANY($3::bigint[]))`,
      [st.storeId, opts.allVariants === true, opts.variantIds ?? null],
    );
    const locById = new Map(locations.map((l) => [l.locationId, l]));
    return rows.map((r) => {
      const status: NsVariantStock["status"] =
        r.productStatus !== "ACTIVE" || r.variantStatus !== "ACTIVE" ? "closed" : r.visibility === "hidden" || r.visible === false ? "paused" : "active";
      let levels: { locationId: string; stock: number | null }[];
      if (r.hasLevels) levels = r.levels ?? [];
      else levels = fallback ? [{ locationId: fallback.locationId, stock: r.stock }] : [];
      const enriched = levels.map((l) => {
        const loc = locById.get(l.locationId);
        return { ...l, mappingStatus: loc ? loc.mappingStatus : "UNKNOWN", warehouseCode: loc?.warehouseCode ?? null };
      });
      let observed: number | null = 0;
      let reason: string | null = null;
      if (r.stockManagement === false) {
        observed = null;
        reason = "Estoque não controlado na Nuvemshop (ilimitado)";
      } else if (r.stockManagement !== true) {
        observed = null;
        reason = "Controle de estoque não informado pela Nuvemshop";
      } else if (!enriched.length) {
        observed = null;
        reason = "Localização do estoque não identificada";
      } else {
        for (const l of enriched) {
          if (l.mappingStatus === "EXCLUDED") continue;
          if (l.mappingStatus !== "MAPPED") {
            if ((l.stock ?? 0) !== 0 || l.stock === null) {
              observed = null;
              reason = `Estoque na localização ${l.locationId} sem associação a depósito`;
              break;
            }
            continue;
          }
          if (l.warehouseCode !== this.warehouse) continue;
          if (l.stock === null) {
            observed = null;
            reason = "Nível de estoque desconhecido";
            break;
          }
          observed = (observed ?? 0) + Math.max(0, l.stock);
        }
      }
      return {
        key: `ns:${st.storeId}:${r.variantId}`,
        storeId: st.storeId!,
        variantId: r.variantId,
        productId: r.productId,
        title: r.title,
        sku: r.sku,
        stockManagement: r.stockManagement,
        totalStock: r.stock,
        levels: enriched,
        observed,
        observedReason: reason,
        status,
        readAt: r.fetchedAt ? new Date(r.fetchedAt) : null,
      };
    });
  }

  validateInventoryCapability(l: Pick<ChannelListingInventory, "status" | "logisticType" | "components">): CapabilityResult {
    if (l.status === "closed") return { managedByAds: true, writableByApi: false, code: "NOT_ACTIVE", reason: "Variante ou produto removido na Nuvemshop" };
    if (!l.components.length) return { managedByAds: true, writableByApi: false, code: "NOT_LINKED", reason: "Sem vínculo confirmado com produto ADS" };
    // Fase 1: leitura apenas — a escrita na Nuvemshop está bloqueada.
    return { managedByAds: true, writableByApi: false, code: "READ_ONLY_PHASE1", reason: "Nuvemshop em somente leitura (Fase 1)" };
  }

  async getChannelInventory(opts: { productIds?: number[] } = {}): Promise<ChannelListingInventory[]> {
    const st = await this.state();
    if (!st.storeId) return [];
    const stocks = new Map((await this.getInventorySnapshot()).map((s) => [s.variantId, s]));
    const mappings = await this.sql.query<{ variantId: string; productId: number; components: { productId: number; quantity: number }[] | null }>(
      `SELECT m.variant_id::text AS "variantId", m.product_id AS "productId",
              (SELECT json_agg(json_build_object('productId', c.product_id, 'quantity', c.quantity)) FROM nuvemshop_mapping_components c WHERE c.mapping_id = m.id) AS components
       FROM nuvemshop_variant_mappings m WHERE m.store_id = $1 AND m.status = 'CONFIRMED'`,
      [st.storeId],
    );
    const wanted = opts.productIds ? new Set(opts.productIds) : null;
    const out: ChannelListingInventory[] = [];
    for (const m of mappings) {
      const components = m.components?.length ? m.components : [{ productId: m.productId, quantity: 1 }];
      if (wanted && !components.some((c) => wanted.has(c.productId))) continue;
      const s = stocks.get(m.variantId);
      const listing: ChannelListingInventory = {
        key: s?.key ?? `ns:${st.storeId}:${m.variantId}`,
        itemIds: [m.variantId],
        title: s?.title ?? null,
        components,
        announced: s ? s.observed : null,
        status: s?.status ?? "closed",
        logisticType: null,
        readAt: s?.readAt ?? null,
        capability: { managedByAds: true, writableByApi: false, code: null, reason: null },
        maxQuantity: null,
      };
      listing.capability = this.validateInventoryCapability(listing);
      out.push(listing);
    }
    return out;
  }

  async getProductMappings(): Promise<ChannelMapping[]> {
    const st = await this.state();
    if (!st.storeId) return [];
    const rows = await this.sql.query<{ variantId: string; productId: number; status: string; reason: string | null; components: { productId: number; quantity: number }[] | null }>(
      `SELECT m.variant_id::text AS "variantId", m.product_id AS "productId", m.status, m.review_reason AS reason,
              (SELECT json_agg(json_build_object('productId', c.product_id, 'quantity', c.quantity)) FROM nuvemshop_mapping_components c WHERE c.mapping_id = m.id) AS components
       FROM nuvemshop_variant_mappings m WHERE m.store_id = $1 AND m.status IN ('CONFIRMED', 'NEEDS_REVIEW')`,
      [st.storeId],
    );
    return rows.map((r) => ({
      key: `ns:${st.storeId}:${r.variantId}`,
      itemIds: [r.variantId],
      components: r.components?.length ? r.components : [{ productId: r.productId, quantity: 1 }],
      trusted: r.status === "CONFIRMED",
      problem: r.status === "NEEDS_REVIEW" ? `Vínculo da variante ${r.variantId} em revisão: ${r.reason ?? "revisar"}` : null,
    }));
  }

  prepareStockUpdate(listing: ChannelListingInventory, target: number): PreparedStockUpdate {
    return { channel: this.channel, key: listing.key, current: listing.announced, target, operation: `Simulação (Fase 1, somente leitura): variante ${listing.itemIds[0]} → ${target}`, simulated: true };
  }

  async applyStockUpdate(update: PreparedStockUpdate): Promise<never> {
    return assertRemoteWriteAllowed(`Nuvemshop ${update.key} → ${update.target}`);
  }

  /** Conferência só com o último dado importado (sem rede). */
  async verifyStockUpdate(update: PreparedStockUpdate): Promise<VerifyResult> {
    const variantId = update.key.split(":").pop()!;
    const [s] = await this.getInventorySnapshot({ allVariants: true, variantIds: [variantId] });
    return { key: update.key, observed: s?.observed ?? null, matches: s?.observed === update.target, readAt: s?.readAt ?? new Date() };
  }
}

/** Exposição observada na Nuvemshop de um produto ADS (unidades físicas), só de variantes ativas. */
export function nsExposure(productId: number, listings: ChannelListingInventory[]): { confirmed: number | null; listings: number; unknownReason: string | null } {
  let confirmed: number | null = 0;
  let count = 0;
  let unknownReason: string | null = null;
  for (const l of listings) {
    const c = l.components.find((x) => x.productId === productId);
    if (!c || l.status !== "active") continue;
    count++;
    if (l.announced === null || confirmed === null) {
      confirmed = null;
      unknownReason ??= `Quantidade desconhecida na variante ${l.itemIds[0]}`;
    } else confirmed += l.announced * c.quantity;
  }
  return { confirmed, listings: count, unknownReason };
}
