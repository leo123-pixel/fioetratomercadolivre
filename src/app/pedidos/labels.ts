type Label = { text: string; tone: "ok" | "warn" | "info" | "danger" | "" };

export const ADS_STATUS_LABEL: Record<string, Label> = {
  RECEIVED: { text: "Recebido", tone: "info" },
  PROCESSING: { text: "Processando", tone: "info" },
  READY_FOR_MAPPING: { text: "Aguardando mapeamento", tone: "warn" },
  READY_FOR_ADS: { text: "Pronto para ADS (não enviado)", tone: "ok" },
  BLOCKED: { text: "Bloqueado", tone: "danger" },
  ERROR: { text: "Erro", tone: "danger" },
  ADS_SENDING: { text: "Envio à ADS a conferir", tone: "warn" },
  ADS_SENT: { text: "Enviado à ADS", tone: "info" },
};

export const MAPPING_LABEL: Record<string, Label> = {
  MAPPED: { text: "Todos vinculados", tone: "ok" },
  PARTIAL: { text: "Parcial", tone: "warn" },
  UNMAPPED: { text: "Sem vínculo (UNMAPPED)", tone: "danger" },
  PENDING: { text: "Pendente", tone: "" },
};

export const PAYMENT_LABEL: Record<string, Label> = {
  approved: { text: "Aprovado", tone: "ok" },
  pending: { text: "Pendente", tone: "warn" },
  in_process: { text: "Em análise", tone: "warn" },
  authorized: { text: "Autorizado", tone: "info" },
  rejected: { text: "Recusado", tone: "danger" },
  cancelled: { text: "Cancelado", tone: "danger" },
  refunded: { text: "Devolvido", tone: "danger" },
  charged_back: { text: "Estornado", tone: "danger" },
};

export const ORDER_STATUS_LABEL: Record<string, Label> = {
  confirmed: { text: "Confirmado", tone: "info" },
  payment_required: { text: "Aguardando pagamento", tone: "warn" },
  payment_in_process: { text: "Pagamento em processo", tone: "warn" },
  partially_paid: { text: "Parcialmente pago", tone: "warn" },
  paid: { text: "Pago", tone: "ok" },
  partially_refunded: { text: "Parcialmente devolvido", tone: "warn" },
  pending_cancel: { text: "Cancelamento pendente", tone: "warn" },
  cancelled: { text: "Cancelado", tone: "danger" },
  invalid: { text: "Inválido", tone: "danger" },
};

export const MAPPING_METHOD_LABEL: Record<string, string> = {
  LISTING: "anúncio publicado pelo integrador",
  USER_PRODUCT: "User Product do anúncio",
  SELLER_SKU: "SKU ADS-<produto>",
  MANUAL: "manual",
};
