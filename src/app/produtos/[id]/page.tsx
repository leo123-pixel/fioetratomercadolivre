import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/page-guard";
import { getDraftByProduct } from "@/lib/catalog/drafts";
import { listImages, RECOMMENDED_MIN_SIDE } from "@/lib/catalog/images";
import { getProduct, getProductPrices, getProductStocks, stockStatus } from "@/lib/catalog/products";
import { getCatalogSettings, listPriceTables } from "@/lib/catalog/settings";
import { ConfigError } from "@/lib/env";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { ListingCard } from "./ListingCard";
import { ImageManager, type ImageView } from "./ImageManager";
import { NameEditor, RefreshButtons } from "./ProductActions";

export const dynamic = "force-dynamic";

function dim(value: string | null): string {
  if (value === null) return "—";
  return Number(value) === 0 ? "0 (não informado na ADS)" : formatNumber(value, 4);
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  if ((await requireAdminPage(`/produtos/${encodeURIComponent(rawId)}`)) === "config") return <PageProblem kind="config" />;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) notFound();

  const sql = getSql();
  let data;
  try {
    const product = await getProduct(sql, id);
    if (!product) notFound();
    const [prices, stocks, images, draft, settings, tables] = await Promise.all([
      getProductPrices(sql, id),
      getProductStocks(sql, id),
      listImages(sql, id),
      getDraftByProduct(sql, id),
      getCatalogSettings(sql),
      listPriceTables(sql),
    ]);
    data = { product, prices, stocks, images, draft, settings, tables };
  } catch (err) {
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_")) throw err;
    logger.error("Falha ao carregar produto", { id, err });
    return <PageProblem kind={err instanceof ConfigError ? "config" : "database"} />;
  }
  const { product, prices, stocks, images, draft, settings, tables } = data;
  const status = stockStatus(stocks);
  const stockTotal = stocks.reduce((acc, s) => acc + Number(s.quantity), 0);

  const imageViews: ImageView[] = images.map((i) => ({
    id: i.id,
    publicUrl: i.publicUrl,
    width: i.width,
    height: i.height,
    isPrimary: i.isPrimary,
    originalFilename: i.originalFilename,
    sizeBytes: i.sizeBytes,
  }));

  return (
    <>
      <p className="breadcrumb">
        <a href="/produtos">Produtos</a> › ID ADS {product.adsProductId}
      </p>
      <div className="page-head">
        <div>
          <h1 style={{ marginBottom: 4 }}>{product.nameCustom ?? (product.nameOriginal || "(sem descrição na ADS)")}</h1>
          <div className="toolbar">
            {product.inactive ? <span className="chip danger">Inativo na ADS</span> : <span className="chip ok">Ativo na ADS</span>}
            {status === "positive" && <span className="chip ok">Com estoque</span>}
            {status === "zero" && <span className="chip warn">Sem estoque</span>}
            {status === "unknown" && <span className="chip">Estoque desconhecido</span>}
            {images.length === 0 && <span className="chip">Sem imagem</span>}
          </div>
        </div>
        <RefreshButtons productId={product.id} />
      </div>

      {product.inactive && (
        <div className="alert warn">Produto inativo na ADS: não é sugerido para publicação e não pode ser marcado como pronto.</div>
      )}

      <div className="two-col">
        <section className="card" aria-labelledby="origem">
          <h2 id="origem">Dados de origem (ADS)</h2>
          <dl className="details">
            <div>
              <dt>ID ADS</dt>
              <dd>{product.adsProductId}</dd>
            </div>
            <div>
              <dt>EAN</dt>
              <dd>{product.ean ?? "—"}</dd>
            </div>
            <div>
              <dt>Código fabricante</dt>
              <dd>{product.manufacturerCode ?? "—"}</dd>
            </div>
            <div>
              <dt>DUN-14</dt>
              <dd>{product.dun14 ?? "—"}</dd>
            </div>
            <div>
              <dt>NCM</dt>
              <dd>{product.ncm ?? "—"}</dd>
            </div>
            <div>
              <dt>Fornecedor</dt>
              <dd>{product.supplierName ? `${product.supplierName} (#${product.supplierId})` : product.supplierId !== null ? `#${product.supplierId}` : "—"}</dd>
            </div>
            <div>
              <dt>Divisão</dt>
              <dd>{product.divisionId ? `${product.divisionId}${product.divisionName ? ` · ${product.divisionName}` : ""}` : "—"}</dd>
            </div>
            <div>
              <dt>Apresentação / unidade</dt>
              <dd>
                {product.presentation ?? "—"} · {product.unit ?? "—"}
                {product.packageQty !== null ? ` · emb. ${product.packageQty}` : ""}
              </dd>
            </div>
            <div>
              <dt>Peso bruto / líquido (kg)</dt>
              <dd>
                {dim(product.grossWeight)} / {dim(product.netWeight)}
              </dd>
            </div>
            <div>
              <dt>Dimensões L × A × C</dt>
              <dd>
                {dim(product.width)} × {dim(product.height)} × {dim(product.length)}
              </dd>
            </div>
            <div>
              <dt>B2B (ADS)</dt>
              <dd>{product.b2b === null ? "—" : product.b2b ? "Sim" : "Não"}</dd>
            </div>
            <div>
              <dt>Situação cadastral</dt>
              <dd>{product.inactive ? "Inativo" : "Ativo"}</dd>
            </div>
            <div>
              <dt>Referência de imagem no ERP</dt>
              <dd title="Caminho interno do ERP; não é acessível pelo navegador">{product.erpImageRef ?? "—"}</dd>
            </div>
            <div>
              <dt>Alterado na ADS / importado</dt>
              <dd>
                {formatDateTime(product.adsUpdatedAt)} / {formatDateTime(product.updatedAt)}
              </dd>
            </div>
          </dl>
          <div style={{ marginTop: 16 }}>
            <dt className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase" }}>
              Descrição original
            </dt>
            <p style={{ margin: "4px 0 12px" }}>{product.nameOriginal || "(vazia na ADS)"}</p>
            <NameEditor productId={product.id} nameCustom={product.nameCustom} nameOriginal={product.nameOriginal} />
          </div>
          <details className="raw" style={{ marginTop: 12 }}>
            <summary>JSON original recebido da ADS</summary>
            <pre>{JSON.stringify(product.rawPayload, null, 2)}</pre>
          </details>
        </section>

        <section className="card" aria-labelledby="estoque">
          <h2 id="estoque">Estoque por filial</h2>
          {stocks.length === 0 ? (
            <p className="muted">Estoque desconhecido: nenhum saldo consultado para este produto. Use “Atualizar preço e estoque”.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Filial</th>
                    <th className="num">Quantidade</th>
                    <th>Última venda (ADS)</th>
                    <th>Consultado em</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.map((s) => (
                    <tr key={s.branchId}>
                      <td>{s.branchId}</td>
                      <td className="num">{formatNumber(s.quantity)}</td>
                      <td>{formatDate(s.lastSaleAt)}</td>
                      <td>{formatDateTime(s.fetchedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stocks.length > 0 && <p className="hint">Total consultado: {formatNumber(stockTotal)}. A semântica do saldo ainda depende de validação com a ADS.</p>}
        </section>
      </div>

      <section className="card" aria-labelledby="precos">
        <h2 id="precos">Preços por tabela comercial</h2>
        {prices.length === 0 ? (
          <p className="muted">Preço indisponível: nenhum preço importado para este produto.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Tabela</th>
                  <th>Filial</th>
                  <th className="num">Preço</th>
                  <th className="num">Desconto</th>
                  <th className="num">Comissão</th>
                  <th className="num">cTeto</th>
                  <th className="num">PVS</th>
                  <th className="num">Qtd. mín.</th>
                  <th>Situação</th>
                  <th>Consultado</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => {
                  const isRef = p.priceTableCode === settings.defaultPriceTable && (!settings.defaultBranchId || settings.defaultBranchId === p.branchId);
                  return (
                    <tr key={`${p.priceTableCode}-${p.branchId}`}>
                      <td>
                        <strong>{p.priceTableCode}</strong> {p.priceTableDescription ? <span className="muted">{p.priceTableDescription}</span> : null}
                        {isRef && <span className="chip info" style={{ marginLeft: 6 }}>referência</span>}
                      </td>
                      <td>{p.branchId}</td>
                      <td className="num">{formatMoney(p.price)}</td>
                      <td className="num">{formatPercent(p.discount)}</td>
                      <td className="num">{formatPercent(p.commission)}</td>
                      <td className="num">{formatMoney(p.ceilingValue)}</td>
                      <td className="num">{formatMoney(p.pvs)}</td>
                      <td className="num">{formatNumber(p.minimumQuantity)}</td>
                      <td>
                        {p.inactive ? <span className="chip danger">Inativo</span> : <span className="chip ok">Ativo</span>}
                        {p.promotion && <span className="chip warn" style={{ marginLeft: 4 }}>Promoção</span>}
                      </td>
                      <td>{formatDateTime(p.fetchedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          Valores comerciais originais da ADS. Desconto, comissão, cTeto e PVS são exibidos sem interpretação: nenhuma regra é aplicada
          automaticamente ao preço do anúncio.
        </p>
      </section>

      <ImageManager productId={product.id} initial={imageViews} recommendedMinSide={RECOMMENDED_MIN_SIDE} />

      <ListingCard
        productId={product.id}
        productInactive={product.inactive}
        draft={draft ? { id: draft.id, status: draft.status, marketplaceItemId: draft.marketplaceItemId, permalink: draft.permalink } : null}
      />
    </>
  );
}
