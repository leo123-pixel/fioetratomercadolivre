import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime, formatNumber } from "@/lib/format";
import { listDiscrepancies, listMovements, listPositions, listReservations, listRunProposals, listRuns, getOverview, RELIABILITY_FILTERS } from "@/lib/inventory/queries";
import { getInventorySettings, listLocations, listPolicyVersions } from "@/lib/inventory/settings";
import { listTransfers } from "@/lib/inventory/transfer-service";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { LocationsEditor, PolicyEditor, RunButton, SettingsEditor, SimulatorPanel, TransferSimulator } from "./ControlPanels";
import { DISCREPANCY_LABEL, QUOTA_LABEL, RELIABILITY_LABEL, RESERVATION_LABEL, SEVERITY_TONE, TRANSFER_LABEL } from "./labels";

export const dynamic = "force-dynamic";

const TABS = [
  ["posicoes", "Posições"],
  ["simulador", "Simulador de cotas"],
  ["divergencias", "Divergências"],
  ["pendentes", "Pedidos pendentes"],
  ["movimentacoes", "Movimentações"],
  ["reconciliacoes", "Reconciliações"],
  ["configuracao", "Configuração"],
] as const;
type Tab = (typeof TABS)[number][0];

type SP = { aba?: string; q?: string; confiabilidade?: string; alertas?: string; page?: string; severidade?: string; status?: string; estado?: string; run?: string };

const j = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const chip = (l: { text: string; tone: string } | undefined, fallback: string) => <span className={`chip ${l?.tone ?? ""}`}>{l?.text ?? fallback}</span>;

function qs(sp: SP, patch: Partial<SP>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, String(v));
  return `?${p.toString()}`;
}

export default async function ControleCentralPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/estoque/controle-central")) === "config") return <PageProblem kind="config" />;
  const tab: Tab = (TABS.map((t) => t[0]) as string[]).includes(sp.aba ?? "") ? (sp.aba as Tab) : "posicoes";
  let overview;
  let body: React.ReactNode = null;
  try {
    const sql = getSql();
    overview = await getOverview(sql);
    body = await renderTab(sql, tab, sp);
  } catch (err) {
    logger.error("Falha ao carregar o controle central de estoque", { err });
    return <PageProblem kind="database" detail="Confira se a migration 20261116000000_inventory_core_shadow foi aplicada." />;
  }
  const shadow = overview.mode.mode === "shadow";
  const pending = overview.reservations.filter((r) => r.state === "PENDING_ERP" || r.state === "REQUIRES_RECONCILIATION").reduce((a, r) => a + r.n, 0);
  return (
    <>
      <p className="breadcrumb">Estoque</p>
      <div className="page-head">
        <h1>Controle central de estoque</h1>
        <span className="muted">
          Última reconciliação: {overview.lastRun ? `${formatDateTime(overview.lastRun.startedAt)} (${overview.lastRun.status})` : "nunca"}
        </span>
      </div>
      <div className="dash-status">
        <span className={`chip wrap ${shadow ? "info" : "warn"}`}>Inventory Core: {shadow ? "modo sombra" : "desativado"}</span>
        <span className="chip wrap danger">Escrita em canais e ERP: bloqueada</span>
        <span className="chip wrap">Estoque do Mercado Livre: continua com o sincronizador atual</span>
      </div>
      {!shadow && <div className="alert warn">{overview.mode.reason} — defina INVENTORY_CORE_MODE=shadow para executar reconciliações. Os dados abaixo são das execuções anteriores.</div>}
      <div className="alert info">
        Valores <span className="real-label">reais</span> vêm da ADS, dos anúncios lidos no Mercado Livre e dos pedidos recebidos. Cotas são{" "}
        <strong>limites de exposição comercial calculados</strong> (não são reservas físicas no ERP) e nada aqui é publicado: a cota do Mercado Livre é uma proposta
        sombra e a da Nuvemshop é <span className="sim">simulada</span>.
      </div>
      <div className="kpis">
        <a className="kpi" href={qs({}, { aba: "posicoes" })}>
          <strong>{overview.counts.pools}</strong>
          <span>pools (SKU × depósito)</span>
        </a>
        <a className="kpi" href={qs({}, { aba: "posicoes", confiabilidade: "RELIABLE" })}>
          <strong>{overview.counts.reliable}</strong>
          <span>confiáveis</span>
        </a>
        <a className="kpi" href={qs({}, { aba: "posicoes", confiabilidade: "DEGRADED" })}>
          <strong>{overview.counts.degraded}</strong>
          <span>degradados (só redução)</span>
        </a>
        <a className="kpi" href={qs({}, { aba: "posicoes", confiabilidade: "UNKNOWN" })}>
          <strong>{overview.counts.unknown + overview.counts.blocked}</strong>
          <span>desconhecidos ou bloqueados</span>
        </a>
        <a className="kpi" href={qs({}, { aba: "divergencias", severidade: "CRITICAL" })}>
          <strong>{overview.discrepancies.critical}</strong>
          <span>divergências críticas</span>
        </a>
        <a className="kpi" href={qs({}, { aba: "pendentes" })}>
          <strong>{pending}</strong>
          <span>compromissos não refletidos na ADS</span>
        </a>
      </div>
      <nav className="tabs" aria-label="Seções">
        {TABS.map(([id, label]) => (
          <a key={id} href={qs({}, { aba: id })} aria-current={tab === id ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {body}
    </>
  );
}

async function renderTab(sql: ReturnType<typeof getSql>, tab: Tab, sp: SP): Promise<React.ReactNode> {
  switch (tab) {
    case "posicoes": {
      const reliability = (RELIABILITY_FILTERS as readonly string[]).includes(sp.confiabilidade ?? "") ? sp.confiabilidade : undefined;
      const data = await listPositions(sql, { q: sp.q, reliability, alerts: sp.alertas === "1", page: Number(sp.page) || 1, pageSize: 50 });
      const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      return (
        <div className="card">
          <form className="filters" method="get">
            <input type="hidden" name="aba" value="posicoes" />
            <div className="field grow">
              <label htmlFor="q">SKU, produto ou código ADS</label>
              <input id="q" type="search" name="q" defaultValue={sp.q ?? ""} placeholder="ADS-1234 ou nome" />
            </div>
            <div className="field">
              <label htmlFor="confiabilidade">Confiabilidade</label>
              <select id="confiabilidade" name="confiabilidade" defaultValue={reliability ?? ""}>
                <option value="">Todas</option>
                {RELIABILITY_FILTERS.map((r) => (
                  <option key={r} value={r}>
                    {RELIABILITY_LABEL[r].text}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="alertas">Alertas</label>
              <select id="alertas" name="alertas" defaultValue={sp.alertas ?? ""}>
                <option value="">Todos</option>
                <option value="1">Só com alerta aberto</option>
              </select>
            </div>
            <div className="field">
              <button className="btn btn-primary" type="submit">
                Filtrar
              </button>
            </div>
          </form>
          <p className="muted">{data.total} pool(s). Clique no SKU para ver as movimentações.</p>
          {data.rows.length === 0 ? (
            <div className="empty-state">Nenhum pool ainda. Rode uma reconciliação em “Reconciliações”.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>SKU / produto</th>
                    <th>Depósito (filiais)</th>
                    <th className="num">
                      Estoque ADS <span className="real-label">real</span>
                    </th>
                    <th className="num">Não refletido na ADS</th>
                    <th className="num">Reserva seg.</th>
                    <th className="num">Disponível seguro</th>
                    <th className="num">Cota ML (proposta)</th>
                    <th className="num">
                      Anunciado ML <span className="real-label">real</span>
                    </th>
                    <th className="num">Diferença</th>
                    <th className="num">
                      Cota Nuvemshop <span className="sim">simulada</span>
                    </th>
                    <th className="num">
                      Lido na Nuvemshop <span className="real-label">real</span>
                    </th>
                    <th className="num">Não alocado</th>
                    <th>Confiabilidade</th>
                    <th className="num">Alertas</th>
                    <th>Última consulta ADS</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.poolId}>
                      <td className="cell-name">
                        <a href={qs({}, { aba: "movimentacoes", q: r.skuCode })}>{r.skuCode}</a>
                        <small>{r.name}</small>
                      </td>
                      <td>
                        {r.warehouseCode}
                        <small className="muted"> ({r.branches ?? "nenhuma filial"})</small>
                      </td>
                      <td className="num">{r.adsStatus === "KNOWN" ? formatNumber(r.adsQuantity) : r.adsStatus === "ERROR" ? <span className="chip danger">falha{r.adsQuantity ? ` (últ. ${formatNumber(r.adsQuantity)})` : ""}</span> : <span className="chip">desconhecido</span>}</td>
                      <td className="num">{formatNumber(r.pendingCommitments)}</td>
                      <td className="num">{r.safetyReserve}</td>
                      <td className="num">
                        <strong>{r.safeSellable ?? "—"}</strong>
                      </td>
                      <td className="num" title={r.mlStatus ? QUOTA_LABEL[r.mlStatus]?.text : undefined}>
                        {r.mlDesired ?? "—"}
                      </td>
                      <td className="num">{r.mlConfirmed ?? "?"}</td>
                      <td className="num">{r.difference === null ? "—" : r.difference > 0 ? `+${r.difference}` : r.difference}</td>
                      <td className="num">
                        <span className="sim">{r.nsDesired ?? "—"}</span>
                      </td>
                      <td className="num">{r.nsObserved ?? "—"}</td>
                      <td className="num">{r.unallocated ?? "—"}</td>
                      <td>
                        {chip(RELIABILITY_LABEL[r.reliability], r.reliability)}
                        {r.reasons.length > 0 && (
                          <ul className="reasons">
                            {r.reasons.slice(0, 3).map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="num">{r.openAlerts ? <span className={`chip ${r.criticalAlerts ? "danger" : "warn"}`}>{r.openAlerts}</span> : "—"}</td>
                      <td>{formatDateTime(r.adsFetchedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="pagination">
              <span className="muted">
                Página {data.page} de {pages}
              </span>
              <div className="pages">
                {data.page > 1 && <a className="btn btn-secondary btn-sm" href={qs(sp, { page: String(data.page - 1) })}>Anterior</a>}
                {data.page < pages && <a className="btn btn-secondary btn-sm" href={qs(sp, { page: String(data.page + 1) })}>Próxima</a>}
              </div>
            </div>
          )}
        </div>
      );
    }
    case "simulador": {
      const [global] = await listPolicyVersions(sql, null, 1);
      const pools = (await listPositions(sql, { pageSize: 200 })).rows.map((r) => ({ poolId: r.poolId, skuCode: r.skuCode, name: r.name }));
      return <SimulatorPanel pools={pools} initialRules={j(global?.rules ?? [])} />;
    }
    case "divergencias": {
      const status = sp.status === "RESOLVED" ? "RESOLVED" : "OPEN";
      const severity = ["CRITICAL", "WARNING", "INFO"].includes(sp.severidade ?? "") ? sp.severidade : undefined;
      const rows = await listDiscrepancies(sql, { status, severity });
      return (
        <div className="card">
          <h2>Relatório de divergências</h2>
          <div className="toolbar" style={{ marginBottom: 12 }}>
            {(["OPEN", "RESOLVED"] as const).map((s) => (
              <a key={s} className={`btn btn-sm ${status === s ? "btn-primary" : "btn-secondary"}`} href={qs({ aba: "divergencias" }, { status: s, severidade: severity })}>
                {s === "OPEN" ? "Abertas" : "Resolvidas"}
              </a>
            ))}
            {["CRITICAL", "WARNING", "INFO"].map((s) => (
              <a key={s} className={`btn btn-sm ${severity === s ? "btn-primary" : "btn-secondary"}`} href={qs({ aba: "divergencias" }, { status, severidade: severity === s ? undefined : s })}>
                {s === "CRITICAL" ? "Críticas" : s === "WARNING" ? "Atenção" : "Informativas"}
              </a>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">Nenhuma divergência {status === "OPEN" ? "aberta" : "resolvida"}.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Gravidade</th>
                    <th>Tipo</th>
                    <th>SKU</th>
                    <th>Descrição</th>
                    <th className="num">Ocorrências</th>
                    <th>Primeira vez</th>
                    <th>{status === "OPEN" ? "Última vez" : "Resolvida em"}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <span className={`chip ${SEVERITY_TONE[d.severity] ?? ""}`}>{d.severity}</span>
                      </td>
                      <td>{DISCREPANCY_LABEL[d.type] ?? d.type}</td>
                      <td>{d.skuCode ?? "—"}</td>
                      <td>{d.message}</td>
                      <td className="num">{d.occurrences}</td>
                      <td>{formatDateTime(d.firstSeenAt)}</td>
                      <td>{formatDateTime(status === "OPEN" ? d.lastSeenAt : d.resolvedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }
    case "pendentes": {
      const all = sp.estado === "todos";
      const rows = await listReservations(sql, { states: all ? undefined : ["PENDING_ERP", "REQUIRES_RECONCILIATION"], q: sp.q });
      return (
        <div className="card">
          <h2>Pedidos com compromisso de estoque</h2>
          <p className="muted">
            “Pendente na ADS” = venda registrada sem evidência de baixa no saldo da ADS (descontada do disponível). Pedido criado na ADS não é considerado baixa
            sem evidência configurada.
          </p>
          <div className="toolbar" style={{ marginBottom: 12 }}>
            <a className={`btn btn-sm ${all ? "btn-secondary" : "btn-primary"}`} href={qs({ aba: "pendentes" }, {})}>
              Pendentes e a reconciliar
            </a>
            <a className={`btn btn-sm ${all ? "btn-primary" : "btn-secondary"}`} href={qs({ aba: "pendentes" }, { estado: "todos" })}>
              Todos
            </a>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">Nenhum compromisso.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Canal</th>
                    <th>SKU</th>
                    <th className="num">Qtd.</th>
                    <th>Estado</th>
                    <th>Envio ADS</th>
                    <th>Situação ADS</th>
                    <th>Data do pedido</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.externalOrderId}
                        {r.simulated && <span className="sim sim-label"> simulado</span>}
                      </td>
                      <td>{r.channel}</td>
                      <td>{r.skuCode}</td>
                      <td className="num">{formatNumber(r.quantity)}</td>
                      <td>
                        {chip(RESERVATION_LABEL[r.state], r.state)}
                        {r.stateReason && <div className="hint">{r.stateReason}</div>}
                      </td>
                      <td>{r.adsSubmissionStatus ? `${r.adsSubmissionStatus}${r.adsPedidoId ? ` · ${r.adsPedidoId}` : ""}` : "não enviado"}</td>
                      <td>{r.adsStatus ?? "—"}</td>
                      <td>{formatDateTime(r.orderCreatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }
    case "movimentacoes": {
      const rows = await listMovements(sql, { q: sp.q, limit: 200 });
      return (
        <div className="card">
          <h2>Livro de movimentações</h2>
          <form className="inline-form" method="get" style={{ marginBottom: 12 }}>
            <input type="hidden" name="aba" value="movimentacoes" />
            <div className="field">
              <label htmlFor="mq">SKU, código ADS ou pedido</label>
              <input id="mq" type="search" name="q" defaultValue={sp.q ?? ""} />
            </div>
            <button className="btn btn-primary" type="submit">
              Buscar
            </button>
          </form>
          <p className="muted">
            “Observado” = fato externo (ex.: saldo e baixa feitos pela ADS). “Interno” = decisão do Inventory Core (reserva local, cota, simulação). O livro é
            somente inclusão.
          </p>
          {rows.length === 0 ? (
            <div className="empty-state">Nenhuma movimentação.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Registrado</th>
                    <th>Evento</th>
                    <th>SKU</th>
                    <th>Canal</th>
                    <th>Pedido</th>
                    <th className="num">Qtd.</th>
                    <th>Origem</th>
                    <th>Natureza</th>
                    <th>Correlação</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id}>
                      <td>{formatDateTime(m.recordedAt)}</td>
                      <td>
                        {m.eventType}
                        {m.status !== "RECORDED" && <small className="muted"> · {m.status}</small>}
                        {m.simulated && <span className="sim sim-label"> simulado</span>}
                      </td>
                      <td>{m.skuCode ?? "—"}</td>
                      <td>{m.channel ?? "—"}</td>
                      <td>{m.externalOrderId ?? "—"}</td>
                      <td className="num">{m.quantity === null ? "—" : formatNumber(m.quantity)}</td>
                      <td>{m.origin}</td>
                      <td>{m.responsibility === "OBSERVED" ? "observado" : "interno"}</td>
                      <td>
                        <code>{m.correlationId.slice(0, 8)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }
    case "reconciliacoes": {
      const runs = await listRuns(sql, 20);
      const selected = runs.find((r) => r.id === sp.run) ?? runs[0];
      const proposals = selected ? await listRunProposals(sql, selected.id) : [];
      return (
        <>
          <div className="card">
            <h2>Reconciliação em modo sombra</h2>
            <p className="muted">
              Lê ADS (cache local ou, opcionalmente, consulta ao vivo somente leitura), anúncios e pedidos; recalcula compromissos, cotas e divergências. Grava só no
              Inventory Core. Não altera Mercado Livre, ADS nem o sincronizador atual.
            </p>
            <RunButton />
          </div>
          <div className="card">
            <h2>Histórico de reconciliação</h2>
            {runs.length === 0 ? (
              <div className="empty-state">Nenhuma execução.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Início</th>
                      <th>Fonte</th>
                      <th>Situação</th>
                      <th className="num">Pools</th>
                      <th className="num">Compromissos</th>
                      <th className="num">Propostas sombra</th>
                      <th className="num">Escritas remotas</th>
                      <th>Por</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => {
                      const s = (r.summary ?? {}) as { pools?: number; orders?: { reservations?: number }; proposals?: { shadowOnly?: number }; remoteWrites?: number };
                      return (
                        <tr key={r.id} className={selected?.id === r.id ? "selected" : undefined}>
                          <td>
                            <a href={qs({ aba: "reconciliacoes" }, { run: r.id })}>{formatDateTime(r.startedAt)}</a>
                          </td>
                          <td>{r.source === "ADS_LIVE" ? "ADS ao vivo" : "cache ADS"}</td>
                          <td>
                            <span className={`chip ${r.status === "COMPLETED" ? "ok" : r.status === "FAILED" ? "danger" : "warn"}`}>{r.status}</span>
                            {r.errorMessage && <div className="hint">{r.errorMessage}</div>}
                          </td>
                          <td className="num">{s.pools ?? "—"}</td>
                          <td className="num">{s.orders?.reservations ?? "—"}</td>
                          <td className="num">{s.proposals?.shadowOnly ?? "—"}</td>
                          <td className="num">{s.remoteWrites ?? 0}</td>
                          <td>{r.requestedBy}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {selected && (
            <div className="card">
              <h2>Propostas da execução (somente sombra — nunca aplicadas)</h2>
              {proposals.length === 0 ? (
                <div className="empty-state">Sem propostas.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th className="num">Anunciado ML</th>
                        <th className="num">Cota calculada</th>
                        <th>Direção</th>
                        <th>Situação</th>
                        <th>Motivo</th>
                        <th>Anúncios</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proposals.map((p) => {
                        const listings = ((p.details as { listings?: { key: string; target: number | null; announced: number | null; reasonCode: string | null }[] } | null)?.listings ?? []);
                        return (
                          <tr key={p.id}>
                            <td>{p.skuCode}</td>
                            <td className="num">{p.currentQuantity ?? "?"}</td>
                            <td className="num">{p.targetQuantity ?? "—"}</td>
                            <td>{p.direction ?? "—"}</td>
                            <td>
                              <span className={`chip ${p.status === "IN_SYNC" ? "ok" : p.status === "BLOCKED" ? "danger" : "info"}`}>{p.status}</span>
                            </td>
                            <td>{p.reason ?? "—"}</td>
                            <td>
                              {listings.map((l) => (
                                <div key={l.key} className="hint">
                                  {l.key}: {l.announced ?? "?"} → {l.target ?? l.reasonCode ?? "—"}
                                </div>
                              ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      );
    }
    case "configuracao": {
      const [locations, policies, settings, transfers, pools] = await Promise.all([
        listLocations(sql),
        listPolicyVersions(sql, null, 10),
        getInventorySettings(sql),
        listTransfers(sql, 20),
        listPositions(sql, { pageSize: 200 }),
      ]);
      return (
        <>
          <LocationsEditor locations={j(locations)} />
          <PolicyEditor versions={j(policies)} />
          <SettingsEditor settings={j(settings)} />
          <TransferSimulator pools={pools.rows.map((r) => ({ poolId: r.poolId, skuCode: r.skuCode, name: r.name, mlDesired: r.mlDesired, nsDesired: r.nsDesired }))} />
          <div className="card">
            <h2>Transferências simuladas</h2>
            {transfers.length === 0 ? (
              <div className="empty-state">Nenhuma transferência simulada.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Pool</th>
                      <th>De → para</th>
                      <th className="num">Qtd.</th>
                      <th>Situação</th>
                      <th>Passos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transfers.map((t) => (
                      <tr key={t.id}>
                        <td>{formatDateTime(t.createdAt)}</td>
                        <td>{t.poolKey}</td>
                        <td>
                          {t.fromChannel} → {t.toChannel}
                        </td>
                        <td className="num">{t.quantity}</td>
                        <td>
                          {chip(TRANSFER_LABEL[t.state], t.state)} <span className="sim sim-label">simulação</span>
                          {t.error && <div className="hint">{t.error}</div>}
                        </td>
                        <td>
                          {t.steps.map((s, i) => (
                            <div key={i} className="hint">
                              {s.state}: {s.note}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      );
    }
  }
}
