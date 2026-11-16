/**
 * Modo de operação do Inventory Core (variável INVENTORY_CORE_MODE).
 *
 *   disabled (padrão quando ausente) — nada roda; leituras do histórico continuam disponíveis.
 *   shadow                           — lê ADS, Mercado Livre e pedidos, calcula, simula e persiste
 *                                      SOMENTE nas tabelas inventory_*. Nunca escreve fora.
 *
 * Não existe modo de escrita nesta fase: qualquer outro valor (ex.: "active") é recusado e tratado
 * como desativado. A escrita remota é bloqueada estruturalmente por assertRemoteWriteAllowed(), que
 * SEMPRE lança — independente do modo, de botões da interface ou de parâmetros de requisição.
 */
export type InventoryCoreMode = "disabled" | "shadow";

export class InventoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

export class InventoryCoreDisabledError extends InventoryError {
  constructor(reason: string) {
    super("inventory_core_disabled", reason, 409);
    this.name = "InventoryCoreDisabledError";
  }
}

/** Tentativa de escrita remota (marketplace ou ERP) a partir do Inventory Core. */
export class InventoryWriteBlockedError extends InventoryError {
  constructor(operation: string) {
    super("inventory_write_blocked", `Escrita remota bloqueada no Inventory Core (fase 0, modo sombra): ${operation}`, 403);
    this.name = "InventoryWriteBlockedError";
  }
}

export interface ModeState {
  mode: InventoryCoreMode;
  /** Valor bruto configurado (para exibição). */
  configured: string | null;
  /** Motivo quando não está em modo sombra. */
  reason: string | null;
  /** Sempre false na fase 0. */
  remoteWritesEnabled: false;
}

export function inventoryCoreMode(env: Record<string, string | undefined> = process.env): ModeState {
  const raw = env.INVENTORY_CORE_MODE?.trim() || null;
  const value = raw?.toLowerCase() ?? null;
  if (value === "shadow") return { mode: "shadow", configured: raw, reason: null, remoteWritesEnabled: false };
  if (!value || value === "disabled" || value === "off") {
    return { mode: "disabled", configured: raw, reason: "INVENTORY_CORE_MODE não está definida como shadow", remoteWritesEnabled: false };
  }
  return {
    mode: "disabled",
    configured: raw,
    reason: `INVENTORY_CORE_MODE="${raw}" não é suportado na fase 0 (somente shadow ou disabled): o Inventory Core permanece desativado`,
    remoteWritesEnabled: false,
  };
}

export function assertInventoryEnabled(env?: Record<string, string | undefined>): void {
  const m = inventoryCoreMode(env);
  if (m.mode !== "shadow") throw new InventoryCoreDisabledError(m.reason ?? "Inventory Core desativado");
}

/**
 * Portão único de escrita remota do Inventory Core. Na fase 0 ele não tem caminho de sucesso:
 * todo adaptador de canal chama este portão em applyStockUpdate, e nenhum módulo do Inventory Core
 * importa funções de escrita do Mercado Livre ou da ADS (verificado por teste automatizado).
 */
export function assertRemoteWriteAllowed(operation: string): never {
  throw new InventoryWriteBlockedError(operation);
}
