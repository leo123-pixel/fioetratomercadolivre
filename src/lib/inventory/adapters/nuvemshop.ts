import { assertRemoteWriteAllowed } from "../mode";
import type { CapabilityResult, ChannelListingInventory, ChannelMapping, InventoryChannelAdapter, PreparedStockUpdate, VerifyResult } from "./types";

/**
 * Nuvemshop — canal SIMULADO na fase 0. Não há integração, credencial nem chamada de rede: nada é lido
 * nem escrito na Nuvemshop. Existe para o Inventory Core calcular cotas simuladas e para validar o
 * contrato InventoryChannelAdapter que a integração real (fase futura) vai implementar.
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
