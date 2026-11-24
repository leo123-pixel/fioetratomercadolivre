import { adsEnvironment } from "@/lib/ads/client";
import { getAdsOrderSettings } from "@/lib/ads/commercial";
import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime, formatMoney } from "@/lib/format";
import { logger } from "@/lib/logger";
import { listNsOrdersForAds } from "@/lib/nuvemshop/ads-orders";
import { getLatestStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { NuvemshopTabs } from "../NuvemshopTabs";

export const dynamic = "force-dynamic";

const FILTERS = { pending: "A enviar", sent: "Enviados", all: "Todos" } as const;
type Filter = keyof typeof FILTERS;

interface Row {
  orderId: string;
  number: string | null;
  status: string | null;
  paymentStatus: string | null;
  createdAt: string | null;
  total: string | null;
  lines: { quantity: number; sku: string | null; variantId: string | null; name?: string | null }[];
  unmappedLines: number;
  adsConfirmedAt: string | null;
  adsSubmission: string | null;
  adsPedidoId: number | null;
  adsStatus: string | null;
}

const SUB_TONE: Record<string, string> = { SENT: "ok", SENDING: "info", UNKNOWN: "warn", FAILED: "danger", CANCELED: "" };

export default async function NuvemshopPedidosPage({ searchParams }: { searchParams: Promise<{ filtro?: string }> }) {
  if ((await requireAdminPage("/nuvemshop/pedidos")) === "config") return <PageProblem kind="config" />;
  const f = (await searchParams).filtro;
  const filter: Filter = f === "sent" || f === "all" ? f : "pending";
  const sql = getSql();
  let rows: Row[] = [];
  let connected = true;
  let configured = false;
  let env: ReturnType<typeof adsEnvironment> | null = null;
  try {
    const store = await getLatestStore(sql);
    connected = !!store;
    if (store) rows = JSON.parse(JSON.stringify(await listNsOrdersForAds(sql, store.storeId, { filter, limit: 200 })));
    configured = !!(await getAdsOrderSettings(sql, "nuvemshop"));
    env = adsEnvironment();
  } catch (err) {
    logger.error("Falha ao carregar os pedidos Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › Pedidos → ADS
      </p>
      <div className="page-head">
        <h1>Pedidos Nuvemshop → ADS</h1>
        <span className="muted">Envio manual, um pedido por vez, com conferência do payload</span>
      </div>
      <NuvemshopTabs current="orders" />
      {env && (
        <div className={`alert ${env.environment === "producao" ? "error" : "warn"}`}>
          Ambiente ADS: <strong>{env.environment === "producao" ? "PRODUÇÃO" : "homologação"}</strong> ({env.host}) ·{" "}
          {env.writeAllowed ? "envio liberado" : "envio BLOQUEADO neste ambiente"}. Nada é enviado automaticamente.
        </div>
      )}
      {!configured && (
        <div className="alert error">
          Configuração comercial da ADS para a Nuvemshop ainda não definida: <a href="/configuracoes/pedidos-ads?canal=nuvemshop">configurar</a>.
        </div>
      )}
      {!connected ? (
        <div className="alert info">Nenhuma loja Nuvemshop conectada.</div>
      ) : (
        <section className="card">
          <nav className="tabs" aria-label="Filtro">
            {(Object.keys(FILTERS) as Filter[]).map((k) => (
              <a key={k} href={`/nuvemshop/pedidos?filtro=${k}`} aria-current={k === filter ? "page" : undefined}>
                {FILTERS[k]}
              </a>
            ))}
          </nav>
          {rows.length === 0 ? (
            <p className="muted">Nenhum pedido neste filtro. Os pedidos chegam pelos webhooks e pela reconciliação periódica.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Data</th>
                    <th>Situação</th>
                    <th>Itens</th>
                    <th>Total</th>
                    <th>ADS</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.orderId}>
                      <td>
                        <a href={`/nuvemshop/pedidos/${o.orderId}`}>#{o.number ?? "—"}</a> <small className="muted">{o.orderId}</small>
                      </td>
                      <td>
                        <small>{formatDateTime(o.createdAt)}</small>
                      </td>
                      <td>
                        {o.status ?? "—"} · <span className={`chip ${o.paymentStatus === "paid" ? "ok" : "warn"}`}>{o.paymentStatus ?? "—"}</span>
                      </td>
                      <td>
                        <small>{(o.lines ?? []).map((l) => `${l.quantity}× ${l.sku ?? l.name ?? l.variantId}`).join(", ")}</small>
                        {o.unmappedLines > 0 && <span className="chip danger"> {o.unmappedLines} sem vínculo</span>}
                      </td>
                      <td>{formatMoney(o.total)}</td>
                      <td>
                        {o.adsSubmission ? (
                          <>
                            <span className={`chip ${SUB_TONE[o.adsSubmission] ?? ""}`}>{o.adsSubmission}</span>
                            {o.adsPedidoId && <small style={{ display: "block" }}>pedido {o.adsPedidoId}{o.adsStatus ? ` · ${o.adsStatus}` : ""}</small>}
                          </>
                        ) : o.adsConfirmedAt ? (
                          <span className="chip info">baixa confirmada à mão</span>
                        ) : (
                          <a className="btn btn-secondary btn-sm" href={`/nuvemshop/pedidos/${o.orderId}`}>
                            Preparar envio
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
