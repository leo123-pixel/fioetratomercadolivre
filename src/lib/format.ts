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

export const DRAFT_STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "info" | "" }> = {
  DRAFT: { text: "Rascunho", tone: "info" },
  READY: { text: "Pronto p/ publicar", tone: "ok" },
  ARCHIVED: { text: "Arquivado", tone: "" },
};

export function stockLabel(total: string | null, branches: number): { text: string; tone: "ok" | "warn" | "" } {
  if (!branches) return { text: "Desconhecido", tone: "" };
  const n = Number(total ?? "0");
  return n > 0 ? { text: formatNumber(total), tone: "ok" } : { text: `${formatNumber(total)} (sem estoque)`, tone: "warn" };
}
