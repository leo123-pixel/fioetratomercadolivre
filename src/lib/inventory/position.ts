/**
 * Posição de estoque de um pool (SKU × depósito compatível) — puro.
 *
 *   estoque vendável ADS  = saldo devolvido por GET /estoques nas filiais MAPEADAS do depósito
 *                           (a ADS não informa separadamente físico × reservado: as reservas internas do
 *                           ERP, se existirem, já estão embutidas nesse saldo e NÃO são descontadas de novo)
 *   compromissos pendentes = reservas locais ainda não refletidas na ADS (PENDING_ERP e
 *                           REQUIRES_RECONCILIATION). REFLECTED_IN_ERP e RELEASED não são descontadas.
 *   disponível seguro      = max(0, ⌊ADS⌋ − ⌈pendentes⌉ − reserva de segurança)
 *
 * Saldo ausente ou falha na ADS NUNCA vira zero: o disponível fica desconhecido (null) e nenhuma cota
 * nova é calculada. Dados degradados (saldo velho, reconciliação pendente, pedido sem vínculo) permitem
 * apenas reduzir a exposição.
 */
import { countsAsPending, type ReservationState } from "./reservations";

export type Reliability = "RELIABLE" | "DEGRADED" | "UNKNOWN" | "BLOCKED";

export interface SnapshotInput {
  status: "KNOWN" | "UNKNOWN" | "ERROR";
  quantity: number | string | null;
  fetchedAt: Date | null;
}

export interface PositionInput {
  snapshot: SnapshotInput;
  reservations: { quantity: number | string; state: ReservationState }[];
  safetyReserve: number;
  now?: Date;
  maxSnapshotAgeMinutes: number;
  /** Impedimentos estruturais (depósito não mapeado, SKU sem vínculo confiável...). */
  blockers?: string[];
  /** Sinais que só permitem redução (pedido sem vínculo, composição conflitante...). */
  degraders?: string[];
}

export interface Position {
  adsQuantity: number | null;
  pendingCommitments: number;
  reflectedCommitments: number;
  safetyReserve: number;
  safeSellable: number | null;
  reliability: Reliability;
  reasons: string[];
  allowIncrease: boolean;
  snapshotAgeMinutes: number | null;
}

const num = (v: number | string) => (typeof v === "number" ? v : Number(v));

export function computePosition(input: PositionInput): Position {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  let pending = 0;
  let reflected = 0;
  let reconciliation = 0;
  for (const r of input.reservations) {
    const q = num(r.quantity);
    if (!Number.isFinite(q) || q <= 0) continue;
    if (countsAsPending(r.state)) pending += q;
    if (r.state === "REQUIRES_RECONCILIATION") reconciliation++;
    if (r.state === "REFLECTED_IN_ERP") reflected += q;
  }
  const reserve = Math.max(0, Math.floor(input.safetyReserve || 0));
  const age = input.snapshot.fetchedAt ? (now.getTime() - input.snapshot.fetchedAt.getTime()) / 60_000 : null;
  const base = { pendingCommitments: pending, reflectedCommitments: reflected, safetyReserve: reserve, snapshotAgeMinutes: age === null ? null : Math.max(0, Math.round(age)) };

  if (input.blockers?.length) {
    return { ...base, adsQuantity: knownQty(input.snapshot), safeSellable: null, reliability: "BLOCKED", reasons: [...input.blockers], allowIncrease: false };
  }
  if (input.snapshot.status === "ERROR") {
    return { ...base, adsQuantity: null, safeSellable: null, reliability: "UNKNOWN", reasons: ["Falha ao consultar a ADS: o saldo não é tratado como zero"], allowIncrease: false };
  }
  const ads = knownQty(input.snapshot);
  if (input.snapshot.status !== "KNOWN" || ads === null) {
    return { ...base, adsQuantity: null, safeSellable: null, reliability: "UNKNOWN", reasons: ["Saldo não encontrado na ADS (desconhecido, não zero)"], allowIncrease: false };
  }
  const safe = Math.max(0, Math.floor(ads) - Math.ceil(pending - 1e-9) - reserve);
  if (age === null || age > input.maxSnapshotAgeMinutes) reasons.push(`Saldo ADS com ${age === null ? "idade desconhecida" : `${Math.round(age)} min`} (máximo ${input.maxSnapshotAgeMinutes} min)`);
  if (reconciliation) reasons.push(`${reconciliation} compromisso(s) aguardando reconciliação`);
  for (const d of input.degraders ?? []) reasons.push(d);
  const reliability: Reliability = reasons.length ? "DEGRADED" : "RELIABLE";
  return { ...base, adsQuantity: ads, safeSellable: safe, reliability, reasons, allowIncrease: reliability === "RELIABLE" };
}

function knownQty(s: SnapshotInput): number | null {
  if (s.status !== "KNOWN" || s.quantity === null) return null;
  const q = num(s.quantity);
  return Number.isFinite(q) ? q : null;
}
