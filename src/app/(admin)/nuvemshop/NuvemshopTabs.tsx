/** Navegação das telas Nuvemshop. */
export function NuvemshopTabs({ current }: { current: "overview" | "products" | "linking" | "simulation" | "automation" }) {
  const tabs = [
    { key: "overview", href: "/nuvemshop", label: "Visão geral" },
    { key: "products", href: "/nuvemshop/produtos", label: "Produtos" },
    { key: "linking", href: "/nuvemshop/produtos/vinculacao", label: "Vinculação ADS" },
    { key: "simulation", href: "/nuvemshop/simulacao", label: "Simulação de estoque" },
    { key: "automation", href: "/nuvemshop/automacoes", label: "Automações" },
  ] as const;
  return (
    <>
      <nav className="tabs" aria-label="Nuvemshop">
        {tabs.map((t) => (
          <a key={t.key} href={t.href} aria-current={t.key === current ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <div className="alert info">
        <strong>Fase 2.</strong> Produtos e imagens são editados manualmente (cada escrita é relida e auditada). Preço e estoque só são escritos pelas{" "}
        <a href="/nuvemshop/automacoes">Automações</a> em PILOTO ou AUTOMÁTICO, nas variantes selecionadas; o estoque sempre vem da cota do Inventory Core. Nenhum pedido vai para a ADS.
      </div>
    </>
  );
}

export const LINK_STATUS: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "info" | "" }> = {
  CONFIRMED: { text: "Vinculado", tone: "ok" },
  NEEDS_REVIEW: { text: "Revisar vínculo", tone: "warn" },
  PENDING: { text: "Sugestão pendente", tone: "info" },
  AMBIGUOUS: { text: "Ambíguo", tone: "warn" },
  UNLINKED: { text: "Sem vínculo", tone: "danger" },
};

export const CRITERION_LABEL: Record<string, string> = {
  EXISTING_LINK: "vínculo existente",
  SKU_MATCH: "SKU",
  GTIN_MATCH: "GTIN",
  MANUFACTURER_MATCH: "cód. fabricante",
  MANUAL: "manual",
};

export const CONFIDENCE_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "info" | "" }> = {
  HIGH: { text: "confiança alta", tone: "ok" },
  MEDIUM: { text: "confiança média", tone: "warn" },
  LOW: { text: "confiança baixa", tone: "danger" },
  MANUAL: { text: "escolha manual", tone: "info" },
};

/** Situação do estoque informado pela Nuvemshop (desconhecido nunca vira zero). */
export function nsStockLabel(stockManagement: boolean | null, stock: number | null): { text: string; tone: "ok" | "warn" | "danger" | "info" | "" } {
  if (stockManagement === false) return { text: "não controlado (ilimitado)", tone: "info" };
  if (stockManagement !== true || stock === null) return { text: "desconhecido", tone: "warn" };
  if (stock > 0) return { text: String(stock), tone: "ok" };
  if (stock === 0) return { text: "0", tone: "danger" };
  return { text: `${stock} (negativo)`, tone: "danger" };
}

export function optionLabel(values: unknown): string | null {
  if (!Array.isArray(values) || !values.length) return null;
  const parts = values
    .map((v) => (typeof v === "string" ? v : v && typeof v === "object" ? ((v as Record<string, string>).pt ?? Object.values(v as Record<string, string>)[0]) : null))
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return parts.length ? parts.join(" / ") : null;
}
