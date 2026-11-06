export const ADS_STATUSES = ["RECEIVED", "PROCESSING", "READY_FOR_MAPPING", "READY_FOR_ADS", "BLOCKED", "ERROR"] as const;
export type AdsStatus = (typeof ADS_STATUSES)[number];

/**
 * Situação mostrada no painel: a preparação acima (derivada do Mercado Livre e recalculada a cada
 * leitura do pedido) substituída pelo envio à ADS quando há um envio vigente no ambiente atual —
 * do próprio pedido ou do pack inteiro. Calculada na consulta, não gravada.
 */
export const ADS_VIEW_STATUSES = [...ADS_STATUSES, "ADS_SENDING", "ADS_SENT", "ADS_SENT_CANCELLED"] as const;
export type AdsViewStatus = (typeof ADS_VIEW_STATUSES)[number];

/** Status de preparação para a ADS (não significa envio). */
export function adsStatusOf(o: { orderStatus: string | null; paymentStatus: string | null; mapping: string; unmapped: number }): { status: AdsStatus; reason: string | null } {
  if (o.orderStatus === "cancelled" || o.orderStatus === "invalid") return { status: "BLOCKED", reason: o.orderStatus === "cancelled" ? "Pedido cancelado no Mercado Livre" : "Pedido inválido no Mercado Livre" };
  if (o.mapping !== "MAPPED") return { status: "READY_FOR_MAPPING", reason: `${o.unmapped} item(ns) sem produto ADS correspondente` };
  if (o.orderStatus === "paid" || o.paymentStatus === "approved") return { status: "READY_FOR_ADS", reason: null };
  return { status: "RECEIVED", reason: `Aguardando confirmação do pagamento (pedido: ${o.orderStatus ?? "?"}, pagamento: ${o.paymentStatus ?? "?"})` };
}

export function mappingStatusOf(total: number, unmapped: number): "MAPPED" | "PARTIAL" | "UNMAPPED" {
  if (!total) return "UNMAPPED";
  if (unmapped === 0) return "MAPPED";
  return unmapped === total ? "UNMAPPED" : "PARTIAL";
}
