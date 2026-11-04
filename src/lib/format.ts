/** Formatação para exibição (cliente e servidor). Valores monetários chegam como string decimal. */

const TZ = "America/Sao_Paulo";

export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
}

export function formatNumber(value: string | number | null | undefined, maxDecimals = 3): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: maxDecimals }).format(n);
}

export function formatPercent(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${formatNumber(value, 4)}%`;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(d);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: TZ }).format(d);
}

export const JOB_TYPE_LABEL: Record<string, string> = {
  PRODUCTS: "Produtos",
  PRICE_TABLES: "Tabelas comerciais",
  PRICES: "Preços",
  STOCKS: "Estoque",
};

export const JOB_STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "info" | "" }> = {
  PENDING: { text: "Na fila", tone: "info" },
  RUNNING: { text: "Em andamento", tone: "info" },
  COMPLETED: { text: "Concluída", tone: "ok" },
  PARTIALLY_COMPLETED: { text: "Concluída com falhas", tone: "warn" },
  FAILED: { text: "Falhou", tone: "danger" },
  CANCELED: { text: "Cancelada", tone: "" },
};

export const DRAFT_STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "info" | "danger" | "" }> = {
  DRAFT: { text: "Rascunho", tone: "info" },
  INCOMPLETE: { text: "Incompleto", tone: "warn" },
  READY: { text: "Pronto (validar no ML)", tone: "info" },
  VALIDATING: { text: "Validando", tone: "info" },
  VALIDATED: { text: "Validado", tone: "ok" },
  PUBLISHING: { text: "Publicando", tone: "info" },
  PUBLISHED: { text: "Publicado", tone: "ok" },
  FAILED: { text: "Falhou", tone: "danger" },
  UNKNOWN: { text: "Resultado desconhecido", tone: "warn" },
  ARCHIVED: { text: "Arquivado", tone: "" },
};

export const PUBLICATION_JOB_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "info" | "danger" | "" }> = {
  QUEUED: { text: "Na fila", tone: "info" },
  RUNNING: { text: "Enviando", tone: "info" },
  SUCCEEDED: { text: "Publicado", tone: "ok" },
  FAILED: { text: "Falhou", tone: "danger" },
  UNKNOWN: { text: "Resultado desconhecido", tone: "warn" },
  CANCELED: { text: "Cancelado", tone: "" },
};

export function stockLabel(total: string | null, branches: number): { text: string; tone: "ok" | "warn" | "" } {
  if (!branches) return { text: "Desconhecido", tone: "" };
  const n = Number(total ?? "0");
  return n > 0 ? { text: formatNumber(total), tone: "ok" } : { text: `${formatNumber(total)} (sem estoque)`, tone: "warn" };
}

/** Status do anúncio no Mercado Livre (lido da API; "deleted" = excluído). */
export const LISTING_STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "info" | "danger" | "" }> = {
  active: { text: "Ativo no ML", tone: "ok" },
  paused: { text: "Pausado no ML", tone: "warn" },
  closed: { text: "Encerrado no ML", tone: "danger" },
  deleted: { text: "Excluído no ML", tone: "danger" },
  under_review: { text: "Em revisão no ML", tone: "warn" },
  inactive: { text: "Inativo no ML", tone: "warn" },
  payment_required: { text: "Pagamento pendente no ML", tone: "warn" },
  not_yet_active: { text: "Ainda não ativo no ML", tone: "info" },
};

export function listingStatusLabel(status: string | null | undefined): { text: string; tone: "ok" | "warn" | "info" | "danger" | "" } {
  if (!status) return { text: "Publicado", tone: "ok" };
  return LISTING_STATUS_LABEL[status] ?? { text: `ML: ${status}`, tone: "" };
}
