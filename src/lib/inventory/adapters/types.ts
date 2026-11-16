/**
 * Interface genérica de canal de vendas para o Inventory Core. Regras de estoque NÃO ficam aqui: o
 * adaptador só traduz entre o modelo central (unidades físicas por produto ADS) e o canal.
 *
 * Fase 0: applyStockUpdate de qualquer adaptador passa pelo portão do Inventory Core
 * (assertRemoteWriteAllowed), que sempre recusa. Nenhum adaptador escreve no canal.
 */
import type { ListingComponent } from "../allocation";

export interface ChannelListingInventory {
  /** Chave do estoque no canal (ex.: "up:..." ou "item:MLB...:var"). */
  key: string;
  itemIds: string[];
  title: string | null;
  components: ListingComponent[];
  /** Quantidade anunciada lida no canal (null = desconhecida). */
  announced: number | null;
  /** Status remoto (active, paused, closed...). */
  status: string | null;
  logisticType: string | null;
  /** Momento da última leitura remota da quantidade. */
  readAt: Date | null;
  capability: CapabilityResult;
  maxQuantity: number | null;
}

export interface ChannelMapping {
  key: string;
  itemIds: string[];
  components: ListingComponent[];
  /** Vínculo confirmado por pessoa/regra validada (sugestões nunca contam). */
  trusted: boolean;
  problem: string | null;
}

export interface CapabilityResult {
  /** O estoque deste anúncio é administrado com o saldo físico da ADS? */
  managedByAds: boolean;
  /** O canal permitiria escrita deste estoque pela API (informativo na fase 0). */
  writableByApi: boolean;
  code: string | null;
  reason: string | null;
}

export interface PreparedStockUpdate {
  channel: string;
  key: string;
  current: number | null;
  target: number;
  /** Descrição da operação que SERIA feita (nunca executada na fase 0). */
  operation: string;
  simulated: boolean;
}

export interface VerifyResult {
  key: string;
  observed: number | null;
  matches: boolean;
  readAt: Date;
}

export interface InventoryChannelAdapter {
  readonly channel: string;
  readonly displayName: string;
  /** Canal ainda não integrado: só simulação. */
  readonly simulated: boolean;
  getChannelInventory(opts?: { productIds?: number[] }): Promise<ChannelListingInventory[]>;
  getProductMappings(): Promise<ChannelMapping[]>;
  validateInventoryCapability(listing: Pick<ChannelListingInventory, "status" | "logisticType" | "components">): CapabilityResult;
  prepareStockUpdate(listing: ChannelListingInventory, target: number): PreparedStockUpdate;
  /** Fase 0: sempre lança InventoryWriteBlockedError. */
  applyStockUpdate(update: PreparedStockUpdate): Promise<never>;
  verifyStockUpdate(update: PreparedStockUpdate): Promise<VerifyResult>;
}
