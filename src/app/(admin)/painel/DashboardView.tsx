import type { DashboardData, SalesDay } from "@/lib/dashboard";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ADS_STATUS_LABEL } from "../pedidos/labels";

const brl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);
const int = (n: number) => new Intl.NumberFormat("pt-BR").format(n);
const plural = (n: number, one: string, many: string) => `${int(n)} ${n === 1 ? one : many}`;
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...opts }).format(new Date(`${iso}T12:00:00Z`));

const JOB_LABEL: Record<string, { text: string; tone: string }> = {
  SUCCEEDED: { text: "aplicado", tone: "ok" },
  QUEUED: { text: "na fila", tone: "info" },
  RUNNING: { text: "executando", tone: "info" },
  DIVERGED: { text: "não refletido", tone: "danger" },
  FAILED: { text: "falhou", tone: "danger" },
  STALE: { text: "não enviado", tone: "warn" },
  SKIPPED: { text: "ignorado", tone: "" },
};

/** Conteúdo do painel (sem acesso a dados): facilita a pré-visualização. */
export function DashboardView({ d }: { d: DashboardData }) {

  const c = d.orders.counts;
  const trend = d.sales.prev7.amount > 0 ? (d.sales.last7.amount - d.sales.prev7.amount) / d.sales.prev7.amount : null;
  const attention = [
    { n: c.READY_FOR_ADS ?? 0, text: "pedido(s) prontos para enviar à ADS", href: "/pedidos?ads=READY_FOR_ADS", tone: "info" },
    { n: c.READY_FOR_MAPPING ?? 0, text: "pedido(s) aguardando vínculo de produto", href: "/pedidos?ads=READY_FOR_MAPPING", tone: "warn" },
    { n: (c.BLOCKED ?? 0) + (c.ERROR ?? 0), text: "pedido(s) bloqueados ou com erro", href: "/pedidos?ads=BLOCKED", tone: "danger" },
    { n: c.ADS_SENDING ?? 0, text: "envio(s) à ADS a conferir", href: "/pedidos?ads=ADS_SENDING", tone: "warn" },
    { n: c.ADS_SENT_CANCELLED ?? 0, text: "pedido(s) cancelados no ML depois do envio à ADS", href: "/pedidos?ads=ADS_SENT_CANCELLED", tone: "danger" },
    { n: d.listings.counts.divergent ?? 0, text: "anúncio(s) com estoque diferente da ADS", href: "/anuncios/vinculacao?filter=divergent", tone: "warn" },
    { n: d.listings.counts.price_divergent ?? 0, text: "anúncio(s) com preço diferente da ADS", href: "/anuncios/vinculacao?filter=price_divergent", tone: "warn" },
    { n: d.listings.counts.unmapped ?? 0, text: "anúncio(s) sem vínculo com produto da ADS", href: "/anuncios/vinculacao?filter=unmapped", tone: "warn" },
    { n: d.stock.problemsToday, text: "atualização(ões) de estoque com falha hoje", href: "/anuncios/vinculacao", tone: "danger" },
    { n: d.events.failed, text: "notificação(ões) do ML com falha nas últimas 24 h", href: "/configuracoes/integracoes/mercadolivre/monitoramento?status=FAILED", tone: "danger" },
  ].filter((a) => a.n > 0);

  const activity = [
    ...d.stock.recent.map((j) => ({
      at: j.completedAt ?? j.createdAt,
      kind: "Estoque",
      item: j.itemIds?.[0] ?? j.poolKey,
      title: j.title,
      change: `${j.beforeQuantity ?? "?"} → ${j.targetQuantity} un.`,
      status: JOB_LABEL[j.status] ?? { text: j.status, tone: "" },
      auto: j.syncMode === "AUTO",
    })),
    ...d.price.recent.map((p) => ({
      at: p.appliedAt!,
      kind: "Preço",
      item: p.marketplaceItemId,
      title: p.title,
      change: `${formatMoney(p.marketplacePrice)} → ${formatMoney(p.appliedPrice ?? p.proposedPrice)}`,
      status: p.status === "APPLIED" ? { text: "aplicado", tone: "ok" } : { text: p.status.toLowerCase(), tone: p.status === "FAILED" || p.status === "DIVERGED" ? "danger" : "" },
      auto: true,
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);

  const conn = d.connection;
  const auto = d.automation;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="breadcrumb">Lopes Cosméticos</p>
          <h1>Painel</h1>
        </div>
        <span className="muted">Atualizado em {formatDateTime(d.generatedAt)} · dados do Mercado Livre e da ADS</span>
      </div>

      <section className="dash-status" aria-label="Situação do sistema">
        <span className={`chip ${conn.status === "connected" ? "ok" : conn.status === "reauth_required" ? "warn" : "danger"}`}>
          Mercado Livre: {conn.status === "connected" ? `conectado${conn.nickname ? ` (${conn.nickname})` : ""}` : conn.status === "reauth_required" ? "reconectar" : "desconectado"}
        </span>
        <span className={`chip ${auto.adsHours.open ? "ok" : "warn"}`} title={auto.adsHours.label}>
          ADS: {auto.adsHours.open ? "dentro do horário" : "fora do horário (automação em pausa)"}
        </span>
        <span className={`chip ${auto.stock.active ? "ok" : ""}`}>Estoque automático: {auto.stock.active ? `a cada ${auto.stock.intervalMin} min` : "desligado"}</span>
        <span className={`chip ${auto.price.active ? "ok" : ""}`}>Preço automático: {auto.price.active ? `a cada ${auto.price.intervalMin} min` : "desligado"}</span>
        <span className="chip">Último ciclo: {d.lastTickAt ? formatDateTime(d.lastTickAt) : "—"}</span>
      </section>

      <section className="dash-kpis" aria-label="Indicadores">
        <Kpi label="Vendas hoje" value={brl(d.sales.today.amount)} note={plural(d.sales.today.orders, "pedido", "pedidos")} href="/pedidos" />
        <Kpi
          label="Últimos 7 dias"
          value={brl(d.sales.last7.amount)}
          note={`${plural(d.sales.last7.orders, "pedido", "pedidos")}${trend === null ? "" : ` · ${trend >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(trend * 100))}% vs. 7 dias anteriores`}`}
          href="/pedidos"
        />
        <Kpi label="Para enviar à ADS" value={int(c.READY_FOR_ADS ?? 0)} note="pedidos prontos, ainda não enviados" href="/pedidos?ads=READY_FOR_ADS" />
        <Kpi label="Estoque atualizado hoje" value={int(d.stock.appliedToday)} note={d.stock.problemsToday ? `${plural(d.stock.problemsToday, "falha", "falhas")} hoje` : "sem falhas hoje"} href="/anuncios/vinculacao" />
        <Kpi label="Preços atualizados hoje" value={int(d.price.appliedToday)} note="tabela M da ADS → Mercado Livre" href="/anuncios/vinculacao" />
        <Kpi
          label="Anúncios no Mercado Livre"
          value={int(d.listings.counts.all ?? 0)}
          note={`${int(d.listings.active)} ativos · ${int(d.listings.paused)} pausados`}
          href="/anuncios/vinculacao?filter=all"
        />
      </section>

      <section className="card" aria-labelledby="dash-sales">
        <div className="dash-card-head">
          <h2 id="dash-sales">Vendas por dia — últimos 14 dias</h2>
          <span className="muted">Valor total dos pedidos (sem cancelados), horário de Campo Grande/MS</span>
        </div>
        <SalesChart days={d.sales.days} />
      </section>

      <div className="two-col">
        <section className="card" aria-labelledby="dash-attention">
          <h2 id="dash-attention">Precisa de atenção</h2>
          {attention.length ? (
            <ul className="dash-list">
              {attention.map((a) => (
                <li key={a.text}>
                  <a href={a.href}>
                    <span className={`chip ${a.tone}`}>{int(a.n)}</span>
                    <span>{a.text}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nada pendente agora.</p>
          )}
          {d.lastAlert && (
            <p className="muted dash-alert">
              Último alerta ({formatDateTime(d.lastAlert.at)}): {d.lastAlert.message}
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="dash-orders">
          <div className="dash-card-head">
            <h2 id="dash-orders">Últimos pedidos</h2>
            <a href="/pedidos">ver todos</a>
          </div>
          {d.orders.recent.length ? (
            <ul className="dash-list dash-rows">
              {d.orders.recent.map((o) => {
                const ads = ADS_STATUS_LABEL[o.adsImportStatus] ?? { text: o.adsImportStatus, tone: "" };
                return (
                  <li key={o.id}>
                    <a href={`/pedidos/${o.id}`}>
                      <span className="dash-row-main">
                        <strong>{formatMoney(o.totalAmount)}</strong>
                        <small>
                          {o.buyerName || o.buyerNickname || "Comprador"} · {plural(o.itemCount, "item", "itens")} · {formatDateTime(o.dateCreated)}
                        </small>
                      </span>
                      <span className={`chip ${ads.tone}`}>{ads.text}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">Nenhum pedido recebido ainda.</p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="dash-activity">
        <div className="dash-card-head">
          <h2 id="dash-activity">Últimas atualizações no Mercado Livre</h2>
          <a href="/anuncios/vinculacao">vinculação, estoque e preço</a>
        </div>
        {activity.length ? (
          <ul className="dash-list dash-rows">
            {activity.map((a, i) => (
              <li key={`${a.kind}-${a.item}-${i}`}>
                <span className="dash-row-main">
                  <span>
                    <span className="chip">{a.kind}</span> <strong>{a.change}</strong>
                  </span>
                  <small>
                    {a.title ?? a.item} · {a.item} · {formatDateTime(a.at)} · {a.auto ? "automático" : "manual"}
                  </small>
                </span>
                <span className={`chip ${a.status.tone}`}>{a.status.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nenhuma atualização registrada ainda.</p>
        )}
      </section>

      <p className="muted">
        Catálogo ADS: {plural(d.products, "produto importado", "produtos importados")} · Horário da ADS: {auto.adsHours.label}
        {d.events.pending ? ` · ${plural(d.events.pending, "notificação do ML na fila", "notificações do ML na fila")}` : ""}
      </p>
    </>
  );
}

function Kpi({ label, value, note, href }: { label: string; value: string; note: string; href: string }) {
  return (
    <a className="dash-kpi" href={href}>
      <span className="dash-kpi-label">{label}</span>
      <span className="dash-kpi-value">{value}</span>
      <span className="dash-kpi-note">{note}</span>
    </a>
  );
}

/** Barras verticais (uma série): valor por dia, rótulo só no maior dia e em hoje; detalhe no foco/hover e tabela acessível. */
function SalesChart({ days }: { days: SalesDay[] }) {
  const max = Math.max(...days.map((d) => d.amount), 0);
  const top = max > 0 ? days.findIndex((d) => d.amount === max) : -1;
  const ticks = max > 0 ? [max, max / 2] : [];
  return (
    <>
      <div className="dash-chart" role="img" aria-label={`Vendas por dia: ${days.map((d) => `${dayLabel(d.day, { day: "2-digit", month: "2-digit" })} ${brl(d.amount)}`).join("; ")}`}>
        <div className="dash-chart-grid" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / max) * 100}%` }}>
              {brl(t)}
            </span>
          ))}
        </div>
        <div className="dash-bars">
          {days.map((d, i) => {
            const h = max > 0 ? (d.amount / max) * 100 : 0;
            const today = i === days.length - 1;
            const label = dayLabel(d.day, { weekday: "short", day: "2-digit", month: "2-digit" });
            return (
              <div className="dash-bar-col" key={d.day} tabIndex={0} aria-label={`${label}: ${brl(d.amount)}, ${plural(d.orders, "pedido", "pedidos")}`}>
                <div className="dash-bar-slot">
                  {(i === top || today) && d.amount > 0 && <span className="dash-bar-value">{brl(d.amount)}</span>}
                  <span className={`dash-bar${today ? " today" : ""}`} style={{ height: `${Math.max(h, d.amount > 0 ? 1.5 : 0)}%` }} />
                </div>
                <span className="dash-bar-x">{dayLabel(d.day, { day: "2-digit" })}</span>
                <span className="dash-tip" role="tooltip">
                  <strong>{label}</strong>
                  {brl(d.amount)} · {plural(d.orders, "pedido", "pedidos")}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <details className="dash-table">
        <summary>Ver em tabela</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Dia</th>
                <th>Pedidos</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{dayLabel(d.day, { weekday: "short", day: "2-digit", month: "2-digit" })}</td>
                  <td>{int(d.orders)}</td>
                  <td>{brl(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
