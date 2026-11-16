import "server-only";
import type { Sql } from "../../sql";
import { loadPools, type Pool } from "../../stock/reconcile";
import { readRemoteState } from "../../stock/remote";
import { assertRemoteWriteAllowed } from "../mode";
import type { CapabilityResult, ChannelListingInventory, ChannelMapping, InventoryChannelAdapter, PreparedStockUpdate, VerifyResult } from "./types";

/**
 * Adaptador Mercado Livre do Inventory Core — SOMENTE LEITURA.
 *
 * Não reescreve nem substitui a integração existente: reaproveita o inventário de anúncios
 * (legacy_listings, lido do ML pela descoberta/reconciliação existentes), os vínculos
 * (marketplace_product_mappings + composições) via loadPools() e, para conferência pontual, a leitura
 * remota readRemoteState() (GET). A escrita de estoque no ML continua exclusiva do sincronizador atual
 * (src/lib/stock/reconcile.ts); applyStockUpdate aqui sempre é recusado pelo portão do Inventory Core.
 */
const TERMINAL = new Set(["closed", "inactive", "under_review", "not_found", "deleted"]);

export class MercadoLivreInventoryAdapter implements InventoryChannelAdapter {
  readonly channel = "mercadolivre";
  readonly displayName = "Mercado Livre";
  readonly simulated = false;

  constructor(private readonly sql: Sql) {}

  private poolsCache: Promise<Pool[]> | null = null;
  private pools(): Promise<Pool[]> {
    this.poolsCache ??= loadPools(this.sql);
    return this.poolsCache;
  }

  validateInventoryCapability(l: Pick<ChannelListingInventory, "status" | "logisticType" | "components">, stockModel?: string | null): CapabilityResult {
    if (l.logisticType === "fulfillment" || stockModel === "FULFILLMENT") {
      return { managedByAds: false, writableByApi: false, code: "FULFILLMENT", reason: "Estoque Full (do Mercado Livre): não faz parte da disponibilidade física administrada pela ADS" };
    }
    if (stockModel === "MULTI_WAREHOUSE") {
      return { managedByAds: false, writableByApi: false, code: "MULTI_WAREHOUSE", reason: "Depósitos do vendedor no ML: exige mapeamento depósito ↔ filial ADS" };
    }
    if (l.status && TERMINAL.has(l.status)) return { managedByAds: true, writableByApi: false, code: "NOT_ACTIVE", reason: `Anúncio ${l.status}: não recebe estoque` };
    if (!l.components.length) return { managedByAds: true, writableByApi: false, code: "NOT_LINKED", reason: "Sem vínculo confiável com produto ADS" };
    return { managedByAds: true, writableByApi: true, code: null, reason: null };
  }

  async getChannelInventory(opts: { productIds?: number[] } = {}): Promise<ChannelListingInventory[]> {
    const pools = await this.pools();
    const models = new Map(
      (
        await this.sql.query<{ poolKey: string; stockModel: string }>(
          `SELECT DISTINCT ON (pool_key) pool_key AS "poolKey", stock_model AS "stockModel" FROM stock_sync_proposals
           WHERE stock_model IS NOT NULL AND stock_model <> 'UNKNOWN' ORDER BY pool_key, created_at DESC`,
        )
      ).map((r) => [r.poolKey, r.stockModel]),
    );
    const wanted = opts.productIds ? new Set(opts.productIds) : null;
    const out: ChannelListingInventory[] = [];
    for (const p of pools) {
      const components = !p.compositionError && p.components ? p.components.map((c) => ({ productId: c.productId, quantity: c.quantity })) : [];
      if (wanted && !p.rows.some((r) => r.productId && wanted.has(r.productId)) && !components.some((c) => wanted.has(c.productId))) continue;
      const live = p.rows.filter((r) => !TERMINAL.has(r.status ?? ""));
      const status = live.some((r) => r.status === "active") ? "active" : live.some((r) => r.status === "paused") ? "paused" : (p.rows[0]?.status ?? null);
      const logisticType = p.rows.every((r) => r.logisticType === "fulfillment") ? "fulfillment" : (p.rows.find((r) => r.logisticType)?.logisticType ?? null);
      const qtys = live.map((r) => r.availableQuantity);
      // Anúncios do mesmo User Product compartilham o estoque: a quantidade é uma só (máximo, conservador).
      const announced = !live.length ? 0 : qtys.some((q) => q === null) ? null : Math.max(...(qtys as number[]));
      const readAt = p.rows.length ? new Date(Math.min(...p.rows.map((r) => new Date(r.lastSeenAt).getTime()))) : null;
      const listing = { status, logisticType, components };
      out.push({
        key: p.key,
        itemIds: p.itemIds,
        title: p.title,
        components,
        announced,
        status,
        logisticType,
        readAt,
        capability: this.validateInventoryCapability(listing, models.get(p.key)),
        maxQuantity: p.maxQuantity,
      });
    }
    return out;
  }

  async getProductMappings(): Promise<ChannelMapping[]> {
    return (await this.pools())
      .filter((p) => p.components || p.compositionError)
      .map((p) => ({
        key: p.key,
        itemIds: p.itemIds,
        components: p.components && !p.compositionError ? p.components.map((c) => ({ productId: c.productId, quantity: c.quantity })) : [],
        trusted: !!p.components && !p.compositionError,
        problem: p.compositionError,
      }));
  }

  prepareStockUpdate(listing: ChannelListingInventory, target: number): PreparedStockUpdate {
    return {
      channel: this.channel,
      key: listing.key,
      current: listing.announced,
      target,
      operation: listing.key.startsWith("up:") ? `Estoque do User Product ${listing.key.slice(3)} → ${target}` : `Quantidade de ${listing.itemIds.join(", ")} → ${target}`,
      simulated: false,
    };
  }

  async applyStockUpdate(update: PreparedStockUpdate): Promise<never> {
    return assertRemoteWriteAllowed(`Mercado Livre ${update.key} → ${update.target}`);
  }

  /** Conferência por leitura remota (GET). Nunca escreve. */
  async verifyStockUpdate(update: PreparedStockUpdate): Promise<VerifyResult> {
    const pool = (await this.pools()).find((p) => p.key === update.key);
    if (!pool) return { key: update.key, observed: null, matches: false, readAt: new Date() };
    const state = await readRemoteState(pool);
    return { key: update.key, observed: state.quantity, matches: state.quantity === update.target, readAt: new Date() };
  }
}
