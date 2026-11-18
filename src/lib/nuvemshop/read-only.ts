/**
 * Política de acesso da Fase 1 da Nuvemshop: SOMENTE LEITURA da loja.
 *
 * NUVEMSHOP_PHASE1_READ_ONLY=true é o valor esperado. A restrição é estrutural: o cliente HTTP só tem
 * caminho de sucesso para GET, e qualquer outro método passa por assertNuvemshopWriteAllowed(), que
 * SEMPRE lança nesta fase — independente da variável (um valor diferente de "true" é tratado como erro de
 * configuração e exibido no painel, mas NÃO libera escrita). Não depende de botões desabilitados no front.
 *
 * Exceções necessárias ao modo leitura (não são escrita comercial na loja): a troca do authorization code
 * pelo token (POST no servidor de autorização) e a persistência local no nosso banco.
 */
export class NuvemshopWriteBlockedError extends Error {
  readonly code = "nuvemshop_write_blocked";
  constructor(readonly operation: string) {
    super(`Escrita na Nuvemshop bloqueada (Fase 1, somente leitura): ${operation}`);
    this.name = "NuvemshopWriteBlockedError";
  }
}

export interface ReadOnlyState {
  /** Sempre true na Fase 1. */
  readOnly: true;
  configured: string | null;
  /** Aviso quando a variável está ausente ou com valor diferente de "true". */
  warning: string | null;
}

export function nuvemshopReadOnlyState(env: Record<string, string | undefined> = process.env): ReadOnlyState {
  const raw = env.NUVEMSHOP_PHASE1_READ_ONLY?.trim() ?? null;
  if (raw?.toLowerCase() === "true") return { readOnly: true, configured: raw, warning: null };
  return {
    readOnly: true,
    configured: raw,
    warning: raw
      ? `NUVEMSHOP_PHASE1_READ_ONLY="${raw}" não é suportado: a Fase 1 é somente leitura e a escrita continua bloqueada`
      : "NUVEMSHOP_PHASE1_READ_ONLY não está definida (o padrão é somente leitura)",
  };
}

/** Portão único de escrita comercial na Nuvemshop. Fase 1: sem caminho de sucesso. */
export function assertNuvemshopWriteAllowed(operation: string): never {
  throw new NuvemshopWriteBlockedError(operation);
}
