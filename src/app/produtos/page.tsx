import { requireAdminPage } from "@/lib/auth/page-guard";
import { getCatalogKpis, listFilterOptions, listProducts } from "@/lib/catalog/products";
import { parseProductQuery, type ProductQuery } from "@/lib/catalog/query";
import { listPriceTables } from "@/lib/catalog/settings";
import { ConfigError } from "@/lib/env";
import { formatDateTime, formatNumber } from "@/lib/format";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../PageProblem";
import { ImportControls } from "./ImportControls";
import { ProductTable, type ProductRowView } from "./ProductTable";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function hrefWith(query: ProductQuery, patch: Partial<Record<keyof ProductQuery, string | number | undefined>>): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...patch } as Record<string, unknown>;
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || (k === "page" && v === 1) || (k === "pageSize" && v === 50)) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `/produtos?${qs}` : "/produtos";
}

export default async function ProdutosPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  if ((await requireAdminPage("/produtos")) === "config") return <PageProblem kind="config" />;

  const query = parseProductQuery(raw);
  const sql = getSql();
  let list, kpis, options, tables;
  try {
    [list, kpis, options, tables] = await Promise.all([listProducts(sql, query), getCatalogKpis(sql), listFilterOptions(sql), listPriceTables(sql)]);
  } catch (err) {
    logger.error("Falha ao carregar o catálogo", { err });
    return <PageProblem kind={err instanceof ConfigError ? "config" : "database"} />;
  }

  const refTable = tables.find((t) => t.code === list.settings.defaultPriceTable);
  const rows: ProductRowView[] = list.items.map((p) => ({
    ...p,
    stockFetchedAt: p.stockFetchedAt ? new Date(p.stockFetchedAt).toISOString() : null,
  }));
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filtered = Object.keys(raw).some((k) => !["page", "pageSize", "sort"].includes(k) && raw[k]);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="breadcrumb">Catálogo ADS</p>
          <h1>Produtos</h1>
        </div>
        <ImportControls hasProducts={kpis.total > 0} />
      </div>

      {kpis.total > 0 && !list.settings.defaultPriceTable && (
        <div className="alert warn">
          Nenhuma tabela de preço de referência definida. <a href="/configuracoes/tabelas-de-preco">Escolha a tabela</a> para exibir o preço de
          referência dos produtos.
        </div>
      )}

      <section className="kpis" aria-label="Resumo do catálogo">
        <a className="kpi" href="/produtos">
          <strong>{formatNumber(kpis.total)}</strong>
          <span>produtos ({formatNumber(kpis.active)} ativos)</span>
        </a>
        <a className="kpi" href="/produtos?stock=positive">
          <strong>{formatNumber(kpis.stockPositive)}</strong>
          <span>com estoque positivo</span>
        </a>
        <a className="kpi" href="/produtos?stock=zero">
          <strong>{formatNumber(kpis.stockZero)}</strong>
          <span>sem estoque (zerado)</span>
        </a>
        <a className="kpi" href="/produtos?stock=unknown">
          <strong>{formatNumber(kpis.stockUnknown)}</strong>
          <span>estoque desconhecido</span>
        </a>
        <a className="kpi" href="/produtos?image=without">
          <strong>{formatNumber(kpis.withoutImage)}</strong>
          <span>sem imagem</span>
        </a>
        <a className="kpi" href="/produtos?draft=any">
          <strong>{formatNumber(kpis.withDraft)}</strong>
          <span>com rascunho ({formatNumber(kpis.readyDrafts)} prontos)</span>
        </a>
      </section>

      <form className="card filters" method="get" action="/produtos" role="search">
        <div className="field grow">
          <label htmlFor="q">Pesquisar</label>
          <input id="q" name="q" type="search" defaultValue={query.q ?? ""} placeholder="Nome, ID ADS, código de fabricante ou EAN" />
        </div>
        <div className="field">
          <label htmlFor="supplierId">Fornecedor</label>
          <select id="supplierId" name="supplierId" defaultValue={query.supplierId ?? ""}>
            <option value="">Todos</option>
            {options.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? `Fornecedor ${s.id}`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="divisionId">Divisão</label>
          <select id="divisionId" name="divisionId" defaultValue={query.divisionId ?? ""}>
            <option value="">Todas</option>
            {options.divisions.map((d) => (
              <option key={d.code} value={d.code}>
                {d.code}
                {d.description ? ` · ${d.description}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="stock">Estoque</label>
          <select id="stock" name="stock" defaultValue={query.stock ?? ""}>
            <option value="">Todos</option>
            <option value="positive">Positivo</option>
            <option value="zero">Zerado</option>
            <option value="unknown">Desconhecido</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Situação</label>
          <select id="status" name="status" defaultValue={query.status ?? ""}>
            <option value="">Todas</option>
            <option value="active">Ativos</option>
            <option value="inactive">Inativos</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="image">Imagens</label>
          <select id="image" name="image" defaultValue={query.image ?? ""}>
            <option value="">Todos</option>
            <option value="with">Com imagem</option>
            <option value="without">Sem imagem</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="draft">Rascunho</label>
          <select id="draft" name="draft" defaultValue={query.draft ?? ""}>
            <option value="">Todos</option>
            <option value="none">Sem rascunho</option>
            <option value="any">Com rascunho</option>
            <option value="DRAFT">Em edição</option>
            <option value="READY">Pronto p/ publicar</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="price">Preço de referência</label>
          <select id="price" name="price" defaultValue={query.price ?? ""}>
            <option value="">Todos</option>
            <option value="with">Com preço</option>
            <option value="without">Sem preço</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">Ordenar por</label>
          <select id="sort" name="sort" defaultValue={query.sort ?? "name"}>
            <option value="name">Nome</option>
            <option value="ads_id">ID ADS</option>
            <option value="stock">Maior estoque</option>
            <option value="updated">Atualização mais recente</option>
          </select>
        </div>
        <div className="toolbar">
          <button className="btn btn-primary" type="submit">
            Filtrar
          </button>
          {filtered && (
            <a className="btn btn-secondary" href="/produtos">
              Limpar
            </a>
          )}
        </div>
      </form>

      {kpis.total === 0 ? (
        <div className="card empty-state">
          <p>
            <strong>Catálogo vazio.</strong>
          </p>
          <p>Use “Importar produtos” para trazer o cadastro da ADS. Depois, atualize preços e estoque.</p>
        </div>
      ) : (
        <>
          <p className="muted">
            {formatNumber(list.total)} produto(s) encontrado(s)
            {refTable ? (
              <>
                {" "}
                · preço de referência: tabela <strong>{refTable.code}</strong> ({refTable.description})
                {list.settings.defaultBranchId ? `, filial ${list.settings.defaultBranchId}` : ""}
              </>
            ) : null}
            {kpis.lastProductImportAt ? ` · última alteração de cadastro: ${formatDateTime(kpis.lastProductImportAt)}` : ""}
          </p>
          <ProductTable rows={rows} referenceTable={list.settings.defaultPriceTable} />
          <nav className="pagination" aria-label="Paginação">
            <span className="muted">
              Página {list.page} de {pages}
            </span>
            <div className="pages">
              {list.page > 1 && (
                <a className="btn btn-secondary btn-sm" href={hrefWith(query, { page: list.page - 1 })}>
                  ← Anterior
                </a>
              )}
              {list.page < pages && (
                <a className="btn btn-secondary btn-sm" href={hrefWith(query, { page: list.page + 1 })}>
                  Próxima →
                </a>
              )}
            </div>
          </nav>
        </>
      )}
    </>
  );
}
