import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { logger } from "@/lib/logger";
import { getOrder } from "@/lib/marketplace/orders";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { ADS_STATUS_LABEL, MAPPING_LABEL, MAPPING_METHOD_LABEL, ORDER_STATUS_LABEL, PAYMENT_LABEL } from "../labels";
import { AdsPanel } from "./AdsPanel";
import { OrderActions } from "./OrderActions";

export const dynamic = "force-dynamic";

type Row = Record<string, string | number | null | boolean | string[]>;

export default async function PedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((await requireAdminPage(`/pedidos/${encodeURIComponent(id)}`)) === "config") return <PageProblem kind="config" />;
  let data;
  try {
    data = await getOrder(getSql(), id);
  } catch (err) {
    logger.error("Falha ao carregar pedido", { err });
    return <PageProblem kind="database" />;
  }
  if (!data) notFound();
  const o = data.order as Row;
  const items = data.items as Row[];
  const payments = data.payments as Row[];
  const shipments = data.shipments as Row[];
  const packOrders = data.packOrders as Row[];
  const ads = ADS_STATUS_LABEL[String(o.adsImportStatus)] ?? { text: String(o.adsImportStatus), tone: "" };
  const st = ORDER_STATUS_LABEL[String(o.orderStatus)] ?? { text: String(o.orderStatus ?? "—"), tone: "" };
  const pay = PAYMENT_LABEL[String(o.paymentStatus)] ?? { text: String(o.paymentStatus ?? "—"), tone: "" };
  const map = MAPPING_LABEL[String(o.mappingStatus)] ?? { text: String(o.mappingStatus), tone: "" };
  const str = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

  return (
    <>
      <p className="breadcrumb">
        <a href="/pedidos">Pedidos</a> › {str(o.marketplaceOrderId)}
      </p>
      <div className="page-head">
        <h1>Pedido {str(o.marketplaceOrderId)}</h1>
        <span className={`chip ${ads.tone}`}>{ads.text}</span>
      </div>
      {o.adsStatusReason && <div className="alert info">{str(o.adsStatusReason)}</div>}
      {o.lastError && <div className="alert error">Último erro: {str(o.lastError)}</div>}

      <section className="card">
        <h2>Resumo</h2>
        <dl className="details">
          <div>
            <dt>Pedido (order_id)</dt>
            <dd>{str(o.marketplaceOrderId)}</dd>
          </div>
          <div>
            <dt>Pack (pack_id)</dt>
            <dd>
              {str(o.packId)}
              {packOrders.length > 0 && (
                <small className="muted" style={{ display: "block" }}>
                  Outros pedidos do pack:{" "}
                  {packOrders.map((p, i) => (
                    <span key={String(p.id)}>
                      {i > 0 && ", "}
                      <a href={`/pedidos/${String(p.id)}`}>{String(p.marketplaceOrderId)}</a>
                    </span>
                  ))}
                </small>
              )}
            </dd>
          </div>
          <div>
            <dt>Data da venda</dt>
            <dd>{formatDateTime(o.dateCreated as string)}</dd>
          </div>
          <div>
            <dt>Status do pedido</dt>
            <dd>
              <span className={`chip ${st.tone}`}>{st.text}</span> {o.orderStatusDetail ? <small className="muted">{str(o.orderStatusDetail)}</small> : null}
            </dd>
          </div>
          <div>
            <dt>Pagamento</dt>
            <dd>
              <span className={`chip ${pay.tone}`}>{pay.text}</span>
            </dd>
          </div>
          <div>
            <dt>Mapeamento</dt>
            <dd>
              <span className={`chip ${map.tone}`}>{map.text}</span>
            </dd>
          </div>
          <div>
            <dt>Comprador</dt>
            <dd>
              {str(o.buyerNickname)} <small className="muted">(ID {str(o.buyerId)})</small>
              {o.buyerName && <small style={{ display: "block" }}>{str(o.buyerName)}</small>}
            </dd>
          </div>
          <div>
            <dt>Vendedor</dt>
            <dd>{str(o.sellerId)}</dd>
          </div>
          <div>
            <dt>Produtos</dt>
            <dd>{formatMoney(o.productsAmount as string)}</dd>
          </div>
          <div>
            <dt>Descontos</dt>
            <dd>{formatMoney(o.discountAmount as string)}</dd>
          </div>
          <div>
            <dt>Frete</dt>
            <dd>{formatMoney(o.shippingAmount as string)}</dd>
          </div>
          <div>
            <dt>Total / pago</dt>
            <dd>
              {formatMoney(o.totalAmount as string)} / {formatMoney(o.paidAmount as string)}
            </dd>
          </div>
          <div>
            <dt>Envio</dt>
            <dd>{str(o.shipmentId)}</dd>
          </div>
          <div>
            <dt>Última atualização no ML</dt>
            <dd>{formatDateTime(o.mlLastUpdated as string)}</dd>
          </div>
          <div>
            <dt>Consultado em</dt>
            <dd>{formatDateTime(o.lastFetchedAt as string)}</dd>
          </div>
        </dl>
        <OrderActions id={String(o.id)} hasRaw={Boolean(o.hasRaw)} />
      </section>

      <section className="card">
        <h2>Itens vendidos</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Anúncio</th>
                <th>Título / SKU</th>
                <th className="num">Qtd.</th>
                <th className="num">Preço unitário vendido</th>
                <th>Produto ADS</th>
                <th>Vínculo</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={`${String(i.itemId)}:${String(i.variationId ?? "")}`}>
                  <td>
                    {str(i.itemId)}
                    {i.variationId && <small className="muted" style={{ display: "block" }}>variação {str(i.variationId)}</small>}
                    {i.userProductId && <small className="muted" style={{ display: "block" }}>UP {str(i.userProductId)}</small>}
                  </td>
                  <td>
                    {str(i.title)}
                    <small className="muted" style={{ display: "block" }}>SKU {str(i.sellerSku)}</small>
                  </td>
                  <td className="num">{formatNumber(i.quantity as string)}</td>
                  <td className="num">
                    {formatMoney(i.unitPrice as string)}
                    {i.fullUnitPrice && i.fullUnitPrice !== i.unitPrice && <small className="muted" style={{ display: "block" }}>cheio {formatMoney(i.fullUnitPrice as string)}</small>}
                  </td>
                  <td>
                    {i.adsProductId ? (
                      <a href={`/produtos/${String(i.productId)}`}>
                        #{String(i.adsProductId)} {i.productName ? `· ${String(i.productName)}` : ""}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {i.mappingStatus === "MAPPED" ? (
                      <span className="chip ok">{MAPPING_METHOD_LABEL[String(i.mappingMethod)] ?? str(i.mappingMethod)}</span>
                    ) : (
                      <>
                        <span className="chip danger">UNMAPPED</span>{" "}
                        <a className="btn btn-secondary btn-sm" href={`/pedidos/mapeamentos?item=${encodeURIComponent(String(i.itemId))}`}>
                          Mapear
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <AdsPanel id={String(o.id)} />

      <section className="card">
        <h2>Pagamentos</h2>
        {payments.length === 0 ? (
          <p className="muted">Nenhum pagamento informado pela API.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Pagamento</th>
                  <th>Situação</th>
                  <th>Meio</th>
                  <th className="num">Valor</th>
                  <th className="num">Frete</th>
                  <th>Aprovado em</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={String(p.paymentId)}>
                    <td>{str(p.paymentId)}</td>
                    <td>
                      {(PAYMENT_LABEL[String(p.status)] ?? { text: str(p.status) }).text}
                      <small className="muted" style={{ display: "block" }}>{str(p.statusDetail)}</small>
                    </td>
                    <td>
                      {str(p.paymentMethodId)} {p.installments ? `· ${String(p.installments)}x` : ""}
                    </td>
                    <td className="num">{formatMoney(p.transactionAmount as string)}</td>
                    <td className="num">{formatMoney(p.shippingCost as string)}</td>
                    <td>{formatDateTime(p.dateApproved as string)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Envio</h2>
        {shipments.length === 0 ? (
          <p className="muted">Sem dados de envio consultados.</p>
        ) : (
          shipments.map((s) => (
            <dl className="details" key={String(s.shipmentId)}>
              <div>
                <dt>Envio</dt>
                <dd>{str(s.shipmentId)}</dd>
              </div>
              <div>
                <dt>Situação</dt>
                <dd>
                  {str(s.status)} {s.substatus ? `(${str(s.substatus)})` : ""}
                </dd>
              </div>
              <div>
                <dt>Logística</dt>
                <dd>
                  {str(s.logisticType)} · {str(s.mode)}
                </dd>
              </div>
              <div>
                <dt>Atualizado no ML</dt>
                <dd>{formatDateTime(s.mlLastUpdated as string)}</dd>
              </div>
            </dl>
          ))
        )}
      </section>
    </>
  );
}
