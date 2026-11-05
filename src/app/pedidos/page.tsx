import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { logger } from "@/lib/logger";
import { ADS_STATUSES, listOrders } from "@/lib/marketplace/orders";
import { kickIfStale } from "@/lib/marketplace/scheduler";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../PageProblem";
import { ADS_STATUS_LABEL, MAPPING_LABEL, PAYMENT_LABEL, ORDER_STATUS_LABEL } from "./labels";

export const dynamic = "force-dynamic";

export default async function PedidosPage({ searchParams }: { searchParams: Promise<{ ads?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/pedidos")) === "config") return <PageProblem kind="config" />;
  const adsStatus = (ADS_STATUSES as readonly string[]).includes(sp.ads ?? "") ? (sp.ads as (typeof ADS_STATUSES)[number]) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  let data;
  try {
    const sql = getSql();
    data = await listOrders(sql, { adsStatus, q: sp.q?.slice(0, 60), page, pageSize: 50 });
    await kickIfStale(sql);
  } catch (err) {
    logger.error("Falha ao carregar pedidos", { err });
    return <PageProblem kind="database" />;
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const total = Object.values(data.counts).reduce((a, n) => a + n, 0);
  const link = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const m = { ads: adsStatus, q: sp.q, ...p };
    for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== "") u.set(k, String(v));
    return `/pedidos?${u.toString()}`;
  };

  return (
    <>
      <p className="breadcrumb">Mercado Livre</p>
      <div className="page-head">
        <h1>Pedidos</h1>
        <span className="muted">Recebidos por notificação (orders_v2) e consultados na API do Mercado Livre</span>
      </div>
      <div className="alert warn" role="note">
        O envio para a ADS é <strong>manual</strong>, pedido a pedido, com confirmação. Nenhum pedido é enviado automaticamente. Produção só com
        escrita habilitada explicitamente. &quot;Pronto para ADS&quot; significa que os dados essenciais foram preparados.
      </div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <a className="btn btn-secondary btn-sm" href="/pedidos/mapeamentos">
          Mapear produtos
        </a>
        <a className="btn btn-secondary btn-sm" href="/configuracoes/pedidos-ads">
          Configuração comercial ADS
        </a>
      </div>
      <nav className="toolbar" aria-label="Preparação para ADS" style={{ marginBottom: 12 }}>
        <a href="/pedidos" className={`btn btn-sm ${!adsStatus ? "btn-primary" : "btn-secondary"}`}>
          Todos ({total})
        </a>
        {ADS_STATUSES.map((s) => (
          <a key={s} href={`/pedidos?ads=${s}`} className={`btn btn-sm ${adsStatus === s ? "btn-primary" : "btn-secondary"}`}>
            {ADS_STATUS_LABEL[s].text} ({data.counts[s] ?? 0})
          </a>
        ))}
      </nav>
      <form method="get" action="/pedidos" className="toolbar" style={{ marginBottom: 12 }} role="search">
        {adsStatus && <input type="hidden" name="ads" value={adsStatus} />}
        <input type="search" name="q" defaultValue={sp.q ?? ""} placeholder="Nº do pedido, pack ou apelido do comprador" style={{ maxWidth: 360 }} />
        <button className="btn btn-secondary btn-sm" type="submit">
          Pesquisar
        </button>
      </form>
      {data.items.length === 0 ? (
        <div className="card empty-state">
          Nenhum pedido recebido. Os pedidos chegam pelo tópico <code>orders_v2</code> das notificações do Mercado Livre e pela varredura periódica.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Data</th>
                <th>Comprador</th>
                <th className="num">Itens</th>
                <th className="num">Valor total</th>
                <th>Pagamento</th>
                <th>Pedido</th>
                <th>Mapeamento</th>
                <th>Preparação ADS</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => {
                const ads = ADS_STATUS_LABEL[o.adsImportStatus] ?? { text: o.adsImportStatus, tone: "" };
                const map = MAPPING_LABEL[o.mappingStatus] ?? { text: o.mappingStatus, tone: "" };
                const pay = PAYMENT_LABEL[o.paymentStatus ?? ""] ?? { text: o.paymentStatus ?? "—", tone: "" };
                const st = ORDER_STATUS_LABEL[o.orderStatus ?? ""] ?? { text: o.orderStatus ?? "—", tone: "" };
                return (
                  <tr key={o.id}>
                    <td>
                      <a href={`/pedidos/${o.id}`}>{o.marketplaceOrderId}</a>
                      {o.packId && <small className="muted" style={{ display: "block" }}>pack {o.packId}</small>}
                    </td>
                    <td>{formatDateTime(o.dateCreated)}</td>
                    <td>
                      {o.buyerNickname ?? "—"}
                      {o.buyerName && <small className="muted" style={{ display: "block" }}>{o.buyerName}</small>}
                    </td>
                    <td className="num">
                      {o.itemCount}
                      <small className="muted" style={{ display: "block" }}>{formatNumber(o.unitCount)} un.</small>
                    </td>
                    <td className="num">{formatMoney(o.totalAmount)}</td>
                    <td>
                      <span className={`chip ${pay.tone}`}>{pay.text}</span>
                    </td>
                    <td>
                      <span className={`chip ${st.tone}`}>{st.text}</span>
                    </td>
                    <td>
                      <span className={`chip ${map.tone}`}>{map.text}</span>
                    </td>
                    <td>
                      <span className={`chip ${ads.tone}`}>{ads.text}</span>
                      {o.adsStatusReason && <small className="muted" style={{ display: "block" }}>{o.adsStatusReason}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="pagination">
          <span className="muted">
            Página {data.page} de {pages} · {data.total} pedido(s)
          </span>
          <div className="pages">
            {data.page > 1 && (
              <a className="btn btn-secondary btn-sm" href={link({ page: data.page - 1 })}>
                Anterior
              </a>
            )}
            {data.page < pages && (
              <a className="btn btn-secondary btn-sm" href={link({ page: data.page + 1 })}>
                Próxima
              </a>
            )}
          </div>
        </div>
      )}
    </>
  );
}
