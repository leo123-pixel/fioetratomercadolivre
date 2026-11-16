/**
 * Protocolo seguro de transferência de cota entre canais (puro; o executor é injetado).
 *
 *   1. Validar disponibilidade (quantidade ≤ cota de origem, pool confiável).
 *   2. Registrar a transferência pendente (REQUESTED).
 *   3. Preparar a redução na origem (SOURCE_DECREASE_PREPARED).
 *   4. Confirmar a redução por LEITURA REMOTA (SOURCE_DECREASE_CONFIRMED).
 *   5. Só então liberar as unidades ao destino (DESTINATION_INCREASE_PREPARED).
 *   6. Confirmar a atualização do destino (COMPLETED).
 *   7. Persistir o resultado (quem chama grava cada passo).
 *
 * Nunca aumenta o destino primeiro. Falha na redução → BLOCKED (nada é liberado). Resultado incerto →
 * REQUIRES_RECONCILIATION (nada é liberado até conferir). Na fase 0 só existe o executor SIMULADO; o
 * executor real passa pelo portão de escrita do Inventory Core, que sempre recusa (BLOCKED).
 */
import { assertRemoteWriteAllowed, InventoryWriteBlockedError } from "./mode";
import type { Reliability } from "./position";

export type TransferState =
  | "REQUESTED"
  | "SOURCE_DECREASE_PREPARED"
  | "SOURCE_DECREASE_CONFIRMED"
  | "DESTINATION_INCREASE_PREPARED"
  | "COMPLETED"
  | "BLOCKED"
  | "REQUIRES_RECONCILIATION"
  | "REJECTED"
  | "CANCELLED";

export const OPEN_TRANSFER_STATES: TransferState[] = ["REQUESTED", "SOURCE_DECREASE_PREPARED", "SOURCE_DECREASE_CONFIRMED", "DESTINATION_INCREASE_PREPARED", "BLOCKED", "REQUIRES_RECONCILIATION"];

export type RemoteOutcome = "confirmed" | "failed" | "uncertain";

export interface TransferRequest {
  fromChannel: string;
  toChannel: string;
  quantity: number;
  /** Cota atual (confirmada) de cada canal. */
  sourceQuota: number;
  destinationQuota: number;
  /** Disponível seguro do pool. */
  safeSellable: number | null;
  reliability: Reliability;
}

export interface TransferStep {
  state: TransferState;
  at: string;
  sourceQuota: number;
  destinationQuota: number;
  /** Exposição máxima possível neste passo (origem e destino somados no pior caso). */
  worstCaseExposure: number;
  note: string;
}

export interface TransferExecutor {
  readonly simulated: boolean;
  /** Aplica e confere (por leitura) a nova cota da origem. */
  decreaseSource(channel: string, target: number): Promise<RemoteOutcome>;
  /** Aplica e confere a nova cota do destino. */
  increaseDestination(channel: string, target: number): Promise<RemoteOutcome>;
}

export function validateTransfer(r: TransferRequest): string | null {
  if (!Number.isInteger(r.quantity) || r.quantity <= 0) return "Quantidade deve ser um inteiro positivo";
  if (r.fromChannel === r.toChannel) return "Origem e destino devem ser canais diferentes";
  if (r.reliability === "UNKNOWN" || r.reliability === "BLOCKED" || r.safeSellable === null) return "Saldo do pool desconhecido ou bloqueado: transferência não permitida";
  if (r.quantity > r.sourceQuota) return `A origem tem ${r.sourceQuota} unidade(s) de cota; não é possível transferir ${r.quantity}`;
  if (r.sourceQuota + r.destinationQuota > r.safeSellable) return "As cotas atuais já excedem o disponível seguro: reconcilie antes de transferir";
  return null;
}

export interface TransferResult {
  state: TransferState;
  steps: TransferStep[];
  error: string | null;
}

async function run(executor: TransferExecutor, fn: () => Promise<RemoteOutcome>): Promise<{ outcome: RemoteOutcome | "blocked"; error: string | null }> {
  try {
    return { outcome: await fn(), error: null };
  } catch (err) {
    if (err instanceof InventoryWriteBlockedError) return { outcome: "blocked", error: err.message };
    // Exceção sem resposta clara: não se sabe se a escrita aconteceu.
    return { outcome: "uncertain", error: err instanceof Error ? err.message : "erro" };
  }
}

/**
 * Executa o protocolo. `onStep` é chamado a cada passo (para persistir antes de seguir).
 */
export async function runTransferProtocol(r: TransferRequest, executor: TransferExecutor, onStep: (s: TransferStep) => Promise<void> = async () => {}, now: () => Date = () => new Date()): Promise<TransferResult> {
  const steps: TransferStep[] = [];
  let src = r.sourceQuota;
  let dst = r.destinationQuota;
  const push = async (state: TransferState, note: string, worst = src + dst) => {
    const s: TransferStep = { state, at: now().toISOString(), sourceQuota: src, destinationQuota: dst, worstCaseExposure: worst, note };
    steps.push(s);
    await onStep(s);
  };
  const invalid = validateTransfer(r);
  if (invalid) {
    await push("REJECTED", invalid);
    return { state: "REJECTED", steps, error: invalid };
  }
  await push("REQUESTED", `Transferir ${r.quantity} de ${r.fromChannel} para ${r.toChannel}`);
  const srcTarget = src - r.quantity;
  // Enquanto a redução não é confirmada, a origem continua exposta pela cota antiga.
  await push("SOURCE_DECREASE_PREPARED", `Reduzir ${r.fromChannel}: ${src} → ${srcTarget}`);
  const dec = await run(executor, () => executor.decreaseSource(r.fromChannel, srcTarget));
  if (dec.outcome === "blocked" || dec.outcome === "failed") {
    const msg = dec.error ?? `Redução em ${r.fromChannel} falhou`;
    await push("BLOCKED", `${msg}; nada foi liberado para ${r.toChannel}`);
    return { state: "BLOCKED", steps, error: msg };
  }
  if (dec.outcome === "uncertain") {
    const msg = dec.error ?? `Redução em ${r.fromChannel} com resultado incerto`;
    await push("REQUIRES_RECONCILIATION", `${msg}; reconciliar antes de liberar saldo`);
    return { state: "REQUIRES_RECONCILIATION", steps, error: msg };
  }
  src = srcTarget;
  await push("SOURCE_DECREASE_CONFIRMED", `Redução confirmada por leitura em ${r.fromChannel}`);
  const dstTarget = dst + r.quantity;
  // Pior caso daqui em diante: destino já no novo valor (a origem já está reduzida e confirmada).
  await push("DESTINATION_INCREASE_PREPARED", `Liberar ${r.quantity} para ${r.toChannel}: ${dst} → ${dstTarget}`, src + dstTarget);
  const inc = await run(executor, () => executor.increaseDestination(r.toChannel, dstTarget));
  if (inc.outcome === "blocked" || inc.outcome === "failed") {
    const msg = inc.error ?? `Aumento em ${r.toChannel} falhou`;
    // As unidades ficam liberadas mas não expostas: seguro (subexposição), exige nova tentativa ou reconciliação.
    await push("BLOCKED", `${msg}; ${r.quantity} unidade(s) ficam sem canal até nova tentativa`, src + dst);
    return { state: "BLOCKED", steps, error: msg };
  }
  if (inc.outcome === "uncertain") {
    const msg = inc.error ?? `Aumento em ${r.toChannel} com resultado incerto`;
    await push("REQUIRES_RECONCILIATION", `${msg}; conferir o destino`, src + dstTarget);
    return { state: "REQUIRES_RECONCILIATION", steps, error: msg };
  }
  dst = dstTarget;
  await push("COMPLETED", "Transferência concluída e conferida");
  return { state: "COMPLETED", steps, error: null };
}

/** Executor de simulação: resultados roteirizados, nenhuma chamada externa. */
export class SimulatedTransferExecutor implements TransferExecutor {
  readonly simulated = true;
  readonly calls: { op: "decrease" | "increase"; channel: string; target: number }[] = [];
  constructor(private readonly outcomes: { sourceDecrease?: RemoteOutcome; destinationIncrease?: RemoteOutcome } = {}) {}
  async decreaseSource(channel: string, target: number): Promise<RemoteOutcome> {
    this.calls.push({ op: "decrease", channel, target });
    return this.outcomes.sourceDecrease ?? "confirmed";
  }
  async increaseDestination(channel: string, target: number): Promise<RemoteOutcome> {
    this.calls.push({ op: "increase", channel, target });
    return this.outcomes.destinationIncrease ?? "confirmed";
  }
}

/**
 * Executor "real": passaria pelos adaptadores dos canais. Na fase 0 toda escrita remota é recusada pelo
 * portão do Inventory Core, então o protocolo termina BLOCKED sem liberar nada ao destino.
 */
export class GatedRemoteTransferExecutor implements TransferExecutor {
  readonly simulated = false;
  async decreaseSource(channel: string, target: number): Promise<RemoteOutcome> {
    return assertRemoteWriteAllowed(`reduzir a cota de ${channel} para ${target}`);
  }
  async increaseDestination(channel: string, target: number): Promise<RemoteOutcome> {
    return assertRemoteWriteAllowed(`aumentar a cota de ${channel} para ${target}`);
  }
}
