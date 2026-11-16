export type Tone = "ok" | "warn" | "danger" | "info" | "";

export const RELIABILITY_LABEL: Record<string, { text: string; tone: Tone }> = {
  RELIABLE: { text: "confiável", tone: "ok" },
  DEGRADED: { text: "degradado (só redução)", tone: "warn" },
  UNKNOWN: { text: "desconhecido", tone: "danger" },
  BLOCKED: { text: "bloqueado", tone: "danger" },
};

export const RESERVATION_LABEL: Record<string, { text: string; tone: Tone }> = {
  PENDING_ERP: { text: "pendente na ADS", tone: "warn" },
  REQUIRES_RECONCILIATION: { text: "exige reconciliação", tone: "danger" },
  REFLECTED_IN_ERP: { text: "refletido na ADS", tone: "ok" },
  RELEASED: { text: "liberado", tone: "" },
};

export const QUOTA_LABEL: Record<string, { text: string; tone: Tone }> = {
  IN_SYNC: { text: "igual ao anunciado", tone: "ok" },
  PENDING_REMOTE: { text: "difere do anunciado", tone: "warn" },
  UNCONFIRMED: { text: "anunciado desconhecido", tone: "warn" },
  BLOCKED: { text: "bloqueada", tone: "danger" },
  SIMULATED: { text: "simulada", tone: "info" },
};

export const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: "danger", WARNING: "warn", INFO: "info" };

export const DISCREPANCY_LABEL: Record<string, string> = {
  ADS_UNAVAILABLE: "ADS indisponível",
  ADS_STOCK_UNKNOWN: "Saldo ADS desconhecido",
  UNMAPPED_LOCATION: "Filial sem depósito",
  WAREHOUSE_WITHOUT_BRANCH: "Depósito sem filial",
  STOCK_IN_UNMAPPED_BRANCH: "Saldo fora do depósito",
  OVER_EXPOSED: "Anunciado acima do seguro",
  CURRENT_SYNC_PENDING_DIFFERS: "Difere do sincronizador atual",
  STALE_SNAPSHOT: "Saldo ADS antigo",
  UNMAPPED_ORDER_LINE: "Pedido sem vínculo",
  MAPPING_CONFLICT: "Vínculo conflitante",
  ALLOCATION_REQUIRED: "Vários anúncios: regra de divisão",
  RESERVATION_RECONCILIATION: "Compromisso a reconciliar",
};

export const TRANSFER_LABEL: Record<string, { text: string; tone: Tone }> = {
  REQUESTED: { text: "solicitada", tone: "info" },
  SOURCE_DECREASE_PREPARED: { text: "redução preparada", tone: "info" },
  SOURCE_DECREASE_CONFIRMED: { text: "redução confirmada", tone: "info" },
  DESTINATION_INCREASE_PREPARED: { text: "aumento preparado", tone: "info" },
  COMPLETED: { text: "concluída", tone: "ok" },
  BLOCKED: { text: "bloqueada", tone: "danger" },
  REQUIRES_RECONCILIATION: { text: "exige reconciliação", tone: "warn" },
  REJECTED: { text: "recusada", tone: "" },
  CANCELLED: { text: "cancelada", tone: "" },
};
