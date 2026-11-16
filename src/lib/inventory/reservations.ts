/**
 * Compromissos de estoque (puro).
 *
 *   PENDING_ERP              venda registrada no canal, sem evidência de baixa na ADS → DESCONTADA
 *   REQUIRES_RECONCILIATION  resultado incerto (envio à ADS incerto, cancelamento após o envio, pendente há
 *                            tempo demais...) → DESCONTADA (conservador) e sinalizada
 *   REFLECTED_IN_ERP         evidência confiável de que o saldo ADS já contém a baixa → NÃO descontada
 *   RELEASED                 encerrado (cancelado antes da ADS, cancelado na ADS) → NÃO descontada
 *
 * O estado é uma FUNÇÃO PURA do conjunto de fatos observados (e da política), não de uma sequência de
 * transições. Os fatos só se acumulam (união), então:
 *   - repetir um evento (webhook duplicado, worker reiniciado) não muda nada — idempotente;
 *   - a ordem de chegada não importa (cancelamento antes do recebimento dá o mesmo resultado);
 *   - REFLECTED_IN_ERP nunca volta a ser descontado (invariante 4), salvo cancelamento na ADS (RELEASED).
 * O único fato que muda de valor é a situação do envio à ADS; leituras mais antigas que a registrada
 * (adsSubmissionAt) são ignoradas.
 *
 * "Pedido criado na ADS" NÃO equivale a "estoque baixado": o envio SENT só reflete a baixa se a política
 * declarar que a ADS baixa/reserva na criação (adsDeductsOnOrderCreated, padrão false). Sem isso, a evidência
 * é a situação do pedido na ADS listada em adsReflectedStatuses (ex.: "Faturado"), a confirmar com a Tecdisa.
 */

export type ReservationState = "PENDING_ERP" | "REFLECTED_IN_ERP" | "RELEASED" | "REQUIRES_RECONCILIATION";

export type AdsSubmissionFact = "NONE" | "SENT" | "UNCERTAIN" | "FAILED";

export interface ReservationFacts {
  received: boolean;
  channelCancelled: boolean;
  returned: boolean;
  adsSubmission: AdsSubmissionFact;
  /** Momento da observação do envio (para descartar leituras antigas). ISO. */
  adsSubmissionAt: string | null;
  /** A situação do pedido na ADS comprova a baixa do saldo. */
  adsStockConfirmed: boolean;
  adsCancelled: boolean;
  /** Pendente há mais tempo que o limite sem evidência na ADS. */
  stale: boolean;
}

export const EMPTY_FACTS: ReservationFacts = {
  received: false,
  channelCancelled: false,
  returned: false,
  adsSubmission: "NONE",
  adsSubmissionAt: null,
  adsStockConfirmed: false,
  adsCancelled: false,
  stale: false,
};

export type ReservationEventType =
  | "ORDER_RECEIVED"
  | "ORDER_CANCELLED"
  | "ORDER_RETURNED"
  | "ADS_ORDER_CREATED"
  | "ADS_ORDER_UNCERTAIN"
  | "ADS_ORDER_FAILED"
  | "ADS_STOCK_CONFIRMED"
  | "ADS_ORDER_CANCELLED"
  | "STALE_PENDING";

export interface ReservationEvent {
  type: ReservationEventType;
  /** Momento do fato na origem (usado para ordenar a situação do envio à ADS). */
  at?: Date | string | null;
}

export interface ReflectionPolicy {
  adsDeductsOnOrderCreated: boolean;
}

export function countsAsPending(state: ReservationState): boolean {
  return state === "PENDING_ERP" || state === "REQUIRES_RECONCILIATION";
}

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/** Incorpora um evento aos fatos (comutativo e idempotente, exceto a situação do envio, ordenada por `at`). */
export function applyEvent(facts: ReservationFacts, event: ReservationEvent): ReservationFacts {
  const f = { ...facts };
  switch (event.type) {
    case "ORDER_RECEIVED":
      f.received = true;
      break;
    case "ORDER_CANCELLED":
      f.channelCancelled = true;
      break;
    case "ORDER_RETURNED":
      f.returned = true;
      break;
    case "ADS_STOCK_CONFIRMED":
      f.adsStockConfirmed = true;
      break;
    case "ADS_ORDER_CANCELLED":
      f.adsCancelled = true;
      break;
    case "STALE_PENDING":
      f.stale = true;
      break;
    case "ADS_ORDER_CREATED":
    case "ADS_ORDER_UNCERTAIN":
    case "ADS_ORDER_FAILED": {
      const at = iso(event.at);
      const value: AdsSubmissionFact = event.type === "ADS_ORDER_CREATED" ? "SENT" : event.type === "ADS_ORDER_UNCERTAIN" ? "UNCERTAIN" : "FAILED";
      // Leitura mais antiga que a registrada não substitui a mais nova (evento fora de ordem).
      if (f.adsSubmissionAt && at && at < f.adsSubmissionAt) break;
      // SENT é definitivo: uma leitura "incerta"/"falha" com o mesmo instante não rebaixa o envio confirmado.
      if (f.adsSubmission === "SENT" && value !== "SENT" && (!at || !f.adsSubmissionAt || at === f.adsSubmissionAt)) break;
      f.adsSubmission = value;
      f.adsSubmissionAt = at ?? f.adsSubmissionAt;
      break;
    }
  }
  return f;
}

export function applyEvents(facts: ReservationFacts, events: ReservationEvent[]): ReservationFacts {
  return events.reduce(applyEvent, facts);
}

export interface Derived {
  state: ReservationState;
  reason: string;
}

/**
 * Estado a partir dos fatos. `previous` só é usado para manter REFLECTED_IN_ERP (uma vez comprovada a
 * baixa, a venda não volta a ser descontada) e RELEASED terminal.
 */
export function deriveState(facts: ReservationFacts, policy: ReflectionPolicy, previous: ReservationState | null = null): Derived {
  const adsOrderExists = facts.adsSubmission === "SENT" || facts.adsSubmission === "UNCERTAIN";
  if (facts.adsCancelled) return { state: "RELEASED", reason: "Pedido cancelado na ADS: o estorno passa a constar no saldo ADS" };
  const reflected = facts.adsStockConfirmed || (policy.adsDeductsOnOrderCreated && facts.adsSubmission === "SENT") || previous === "REFLECTED_IN_ERP";
  if (reflected) {
    if (facts.channelCancelled) return { state: "REFLECTED_IN_ERP", reason: "Cancelado no canal depois da baixa: o estorno depende do cancelamento no ADSNET" };
    return {
      state: "REFLECTED_IN_ERP",
      reason: facts.adsStockConfirmed ? "Situação do pedido na ADS comprova a baixa do saldo" : previous === "REFLECTED_IN_ERP" ? "Baixa comprovada anteriormente" : "Pedido criado na ADS (política: a ADS baixa na criação)",
    };
  }
  if (previous === "RELEASED" && !adsOrderExists) return { state: "RELEASED", reason: "Compromisso encerrado" };
  if (previous === "RELEASED" && adsOrderExists) return { state: "REQUIRES_RECONCILIATION", reason: "Pedido existe na ADS depois de liberado: conferir no ADSNET" };
  if (facts.channelCancelled) {
    if (!adsOrderExists) return { state: "RELEASED", reason: facts.received ? "Cancelado no canal antes de chegar à ADS" : "Cancelamento recebido antes do pedido: nada a reservar" };
    return { state: "REQUIRES_RECONCILIATION", reason: "Cancelado no canal depois do envio à ADS: cancelar no ADSNET e conferir" };
  }
  if (facts.returned && !adsOrderExists) return { state: "RELEASED", reason: "Devolução de venda que nunca foi baixada na ADS" };
  if (!facts.received) return { state: "REQUIRES_RECONCILIATION", reason: "Evento da ADS sem registro do pedido no canal" };
  if (facts.adsSubmission === "UNCERTAIN") return { state: "REQUIRES_RECONCILIATION", reason: "Envio à ADS com resultado incerto: conciliar pelo idExterno" };
  if (facts.stale) return { state: "REQUIRES_RECONCILIATION", reason: "Pendente há tempo demais sem evidência de baixa na ADS" };
  if (facts.adsSubmission === "SENT") return { state: "PENDING_ERP", reason: "Pedido criado na ADS, mas a baixa do saldo não foi comprovada" };
  return { state: "PENDING_ERP", reason: "Venda registrada no canal; baixa na ADS ainda não comprovada" };
}

/** Fatos que mudaram entre duas versões (para registrar no livro de movimentações). */
export function changedFacts(before: ReservationFacts, after: ReservationFacts): ReservationEventType[] {
  const out: ReservationEventType[] = [];
  if (!before.received && after.received) out.push("ORDER_RECEIVED");
  if (before.adsSubmission !== after.adsSubmission) {
    out.push(after.adsSubmission === "SENT" ? "ADS_ORDER_CREATED" : after.adsSubmission === "UNCERTAIN" ? "ADS_ORDER_UNCERTAIN" : "ADS_ORDER_FAILED");
  }
  if (!before.adsStockConfirmed && after.adsStockConfirmed) out.push("ADS_STOCK_CONFIRMED");
  if (!before.channelCancelled && after.channelCancelled) out.push("ORDER_CANCELLED");
  if (!before.returned && after.returned) out.push("ORDER_RETURNED");
  if (!before.adsCancelled && after.adsCancelled) out.push("ADS_ORDER_CANCELLED");
  if (!before.stale && after.stale) out.push("STALE_PENDING");
  return out;
}
