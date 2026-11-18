import { requireAdminPage } from "@/lib/auth/page-guard";
import { logger } from "@/lib/logger";
import { listVariants, VARIANT_FILTERS, type VariantFilter } from "@/lib/nuvemshop/queries";
import { getLatestStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../../PageProblem";
import { NuvemshopTabs } from "../../NuvemshopTabs";
import { MappingPanel } from "./MappingPanel";

export const dynamic = "force-dynamic";

const FILTER_LABELS: Record<VariantFilter, string> = {
  all: "Todos",
  linked: "Vinculados",
  unlinked: "Não vinculados",
  pending: "Sugestão pendente",
  ambiguous: "Correspondência ambígua",
  review: "Revisar vínculo",
  duplicate_sku: "SKU duplicado",
  no_sku: "Sem SKU",
  no_gtin: "Sem GTIN",
  stock_divergent: "Com divergência de estoque",
  stock_unknown: "Sem estoque conhecido",
  removed: "Removidos na loja",
};

export default async function NuvemshopVinculacaoPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/nuvemshop/produtos/vinculacao")) === "config") return <PageProblem kind="config" />;
  const filter = (VARIANT_FILTERS as readonly string[]).includes(sp.filter ?? "") ? (sp.filter as VariantFilter) : "unlinked";
  const page = Math.max(1, Number(sp.page) || 1);
  let data = null;
  try {
    const sql = getSql();
    const store = await getLatestStore(sql);
    if (store) data = await listVariants(sql, { storeId: store.storeId, filter, q: sp.q, page, pageSize: 50 });
  } catch (err) {
    logger.error("Falha ao carregar a vinculação Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › <a href="/nuvemshop/produtos">Produtos</a> › Vinculação ADS
      </p>
      <div className="page-head">
        <h1>Vinculação Nuvemshop ↔ ADS</h1>
        <span className="muted">Cada variante da Nuvemshop aponta para um produto ADS (identidade do Inventory Core)</span>
      </div>
      <NuvemshopTabs current="linking" />
      <div className="alert info">
        Sugestões vêm de vínculo existente, SKU no padrão ADS-&lt;produtoId&gt;, GTIN válido ou código do fabricante — nunca do título — e só valem depois da sua confirmação.
        Correspondência ambígua exige escolha manual. Kits exigem a composição formal. O lote só confirma as correspondências seguras.
      </div>
      {!data ? (
        <div className="empty-state">Nenhuma loja conectada ainda. Conecte a loja e importe o catálogo na <a href="/nuvemshop">visão geral</a>.</div>
      ) : (
        <MappingPanel
          filter={filter}
          filterLabels={FILTER_LABELS}
          q={sp.q ?? ""}
          rows={JSON.parse(JSON.stringify(data.items))}
          counts={data.counts}
          total={data.total}
          page={data.page}
          pageSize={data.pageSize}
        />
      )}
    </>
  );
}
