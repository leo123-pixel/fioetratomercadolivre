import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime, formatMoney } from "@/lib/format";
import { logger } from "@/lib/logger";
import { listVariants, VARIANT_FILTERS, type VariantFilter } from "@/lib/nuvemshop/queries";
import { getLatestStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { LINK_STATUS, NuvemshopTabs, nsStockLabel, optionLabel } from "../NuvemshopTabs";
import { VariantDetailToggle } from "./VariantDetail";

export const dynamic = "force-dynamic";

const FILTERS: Partial<Record<VariantFilter, string>> = {
  all: "Todas",
  linked: "Vinculadas",
  unlinked: "Sem vínculo",
  no_sku: "Sem SKU",
  stock_unknown: "Sem estoque conhecido",
  removed: "Removidas na loja",
};

const VISIBILITY: Record<string, string> = { visible: "publicado", unlisted: "não listado", hidden: "oculto" };

export default async function NuvemshopProdutosPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/nuvemshop/produtos")) === "config") return <PageProblem kind="config" />;
  const filter = (VARIANT_FILTERS as readonly string[]).includes(sp.filter ?? "") ? (sp.filter as VariantFilter) : "all";
  const page = Math.max(1, Number(sp.page) || 1);
  let data = null;
  try {
    const sql = getSql();
    const store = await getLatestStore(sql);
    if (store) data = await listVariants(sql, { storeId: store.storeId, filter, q: sp.q, page, pageSize: 50 });
  } catch (err) {
    logger.error("Falha ao carregar produtos Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  const qs = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ filter, q: sp.q, page, ...p })) if (v !== undefined && v !== "" && !(k === "page" && v === 1)) u.set(k, String(v));
    return `?${u.toString()}`;
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › Produtos
      </p>
      <div className="page-head">
        <h1>Produtos da Nuvemshop</h1>
        <span className="muted">Dados importados (somente leitura) · para atualizar, use “Atualizar catálogo” na visão geral</span>
      </div>
      <NuvemshopTabs current="products" />
      {!data ? (
        <div className="empty-state">Nenhuma loja conectada ainda. Conecte a loja e importe o catálogo na <a href="/nuvemshop">visão geral</a>.</div>
      ) : (
        <section className="card">
          <form className="filters" method="get" style={{ marginBottom: 12 }}>
            <div className="field grow">
              <label htmlFor="q">Busca</label>
              <input id="q" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Nome, SKU, código de barras, Product ID ou Variant ID" />
            </div>
            <div className="field">
              <label htmlFor="filter">Filtro</label>
              <select id="filter" name="filter" defaultValue={filter}>
                {Object.entries(FILTERS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label} ({data.counts[k as VariantFilter] ?? 0})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <button type="submit" className="btn btn-secondary">
                Filtrar
              </button>
            </div>
          </form>
          {data.items.length === 0 ? (
            <div className="empty-state">Nenhuma variante encontrada.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Produto</th>
                    <th>SKU</th>
                    <th>Product ID / Variant ID</th>
                    <th>Preço</th>
                    <th>Estoque</th>
                    <th>Publicação</th>
                    <th>Vínculo ADS</th>
                    <th>Atualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => {
                    const stock = nsStockLabel(r.stockManagement, r.stock);
                    const link = LINK_STATUS[r.linkStatus];
                    const opt = optionLabel(r.optionValues);
                    return (
                      <tr key={r.variantId}>
                        <td>
                          {r.imageSrc ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="thumb" src={r.imageSrc} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="thumb empty">sem imagem</span>
                          )}
                        </td>
                        <td className="cell-name">
                          {r.productName ?? "—"}
                          {opt && <small>{opt}</small>}
                          {r.isKit && <span className="chip warn">kit</span>}
                          <VariantDetailToggle variantId={r.variantId} />
                        </td>
                        <td>{r.sku ?? <span className="chip warn">sem SKU</span>}</td>
                        <td>
                          <small>
                            {r.productId}
                            <br />
                            {r.variantId}
                          </small>
                        </td>
                        <td>
                          {r.price ? formatMoney(r.price) : "—"}
                          {r.promotionalPrice ? <small className="muted"> promo {formatMoney(r.promotionalPrice)}</small> : null}
                        </td>
                        <td>
                          <span className={`chip ${stock.tone}`}>{stock.text}</span>
                          {r.hasInventoryLevels && <small className="muted"> por local</small>}
                        </td>
                        <td>{r.syncStatus === "REMOVED" ? <span className="chip danger">removido</span> : (VISIBILITY[r.visibility ?? ""] ?? r.visibility ?? "—")}</td>
                        <td>
                          <span className={`chip ${link.tone}`}>{link.text}</span>
                          {r.linkAdsProductId ? <small className="muted"> #{r.linkAdsProductId}</small> : null}
                          <br />
                          <a href={`/nuvemshop/produtos/vinculacao?q=${encodeURIComponent(r.variantId)}&filter=${r.syncStatus === "REMOVED" ? "review" : "all"}`}>vincular / revisar</a>
                        </td>
                        <td>
                          <small>{formatDateTime(r.remoteUpdatedAt)}</small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="pagination">
            <span className="muted">
              {data.total} variante(s) · página {page} de {pages}
            </span>
            <span className="pages">
              {page > 1 && (
                <a className="btn btn-secondary btn-sm" href={qs({ page: page - 1 })}>
                  Anterior
                </a>
              )}
              {page < pages && (
                <a className="btn btn-secondary btn-sm" href={qs({ page: page + 1 })}>
                  Próxima
                </a>
              )}
            </span>
          </div>
        </section>
      )}
    </>
  );
}
