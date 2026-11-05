"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import type { MonitoringSummary } from "@/lib/marketplace/health";

interface EventItem {
  id: string;
  source: string;
  topic: string;
  resource: string;
  actions: string[];
  status: string;
  attempts: number;
  maxAttempts: number;
  receivedAt: string;
  processedAt: string | null;
  nextAttemptAt: string;
  durationMs: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  ignoredReason: string | null;
  coalescedInto: string | null;
  correlationId: string;
}

interface Issue {
  id: string;
  itemId: string;
  issueType: string;
  localValue: string | null;
  remoteValue: string | null;
  details: Record<string, unknown> | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
  draftId: number | null;
}

interface Job {
  id: string;
  type: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  changed: number;
  failed: number;
  error: string | null;
}

type Tone = "ok" | "warn" | "danger" | "info" | "";

const EVENT_TONE: Record<string, Tone> = { COMPLETED: "ok", PENDING: "info", PROCESSING: "info", RETRYING: "warn", FAILED: "danger", IGNORED: "" };
const JOB_LABEL: Record<string, string> = { LISTINGS_RECONCILE: "Reconciliação de anúncios", MISSED_FEEDS: "Notificações perdidas (missed_feeds)", ORDERS_RECOVERY: "Varredura de pedidos" };
const ISSUE_LABEL: Record<string, string> = {
  STATUS_DIVERGENCE: "Status diferente de ativo",
  CLOSED_REMOTE: "Encerrado no ML",
  REMOVED_REMOTE: "Excluído/removido no ML",
  PRICE_DIVERGENCE: "Preço diferente do publicado",
  QUANTITY_DIVERGENCE: "Quantidade diferente da publicada",
  NOT_LINKED: "Anúncio sem correspondência local",
  INCOMPLETE_LINK: "Vínculo incompleto (SELLER_SKU)",
  FETCH_ERROR: "Erro de consulta",
};
const REASON_LABEL: Record<string, string> = {
  unknown_seller: "conta diferente da conectada",
  unsupported_topic: "tópico não tratado",
  unrecognized_resource: "recurso não reconhecido",
  no_local_listing: "sem anúncio local",
  not_found: "recurso não encontrado no ML",
  other_seller: "recurso de outra conta",
};

function ago(iso: string | null): string {
  if (!iso) return "nunca";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

export function MonitoringPanel(props: {
  summary: MonitoringSummary;
  events: { items: EventItem[]; total: number; page: number; pageSize: number };
  issues: Issue[];
  jobs: Job[];
  filters: { status: string; topic: string };
  webhookUrl: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);
  const [detail, setDetail] = useState<{ id: string; data: Record<string, unknown> } | null>(null);
  const s = props.summary;
  const ev = s.events;
  const pending = (ev.byStatus.PENDING ?? 0) + (ev.byStatus.RETRYING ?? 0) + (ev.byStatus.PROCESSING ?? 0);

  // Atualiza os indicadores a cada 30 s (dados locais).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [router]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setFeedback(null);
    try {
      setFeedback({ kind: "success", text: await fn() });
      router.refresh();
    } catch (e) {
      setFeedback({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const testConnection = () =>
    run("test", async () => {
      const r = await api<{ meliUserId: string; nickname: string | null }>("/api/mercadolivre/connection/test", { body: {} });
      if (!r.ok) throw new Error(errorText(r));
      return `Conectividade validada agora: /users/me respondeu para a conta ${r.data.meliUserId}${r.data.nickname ? ` (${r.data.nickname})` : ""}.`;
    });

  const runJob = (type: string) =>
    run(type, async () => {
      const r = await api<{ job: { status: string; processed: number; changed: number; failed: number; error?: string } }>("/api/marketplace/sync-jobs", { body: { type } });
      if (!r.ok) throw new Error(r.status === 409 ? "Já existe uma execução em andamento." : errorText(r));
      const j = r.data.job;
      return `${JOB_LABEL[type]}: ${j.status} · ${j.processed} lido(s), ${j.changed} alterado(s)/novo(s), ${j.failed} falha(s)${j.error ? ` — ${j.error}` : ""}.`;
    });

  const reprocess = (id: string) =>
    run(`ev-${id}`, async () => {
      const r = await api<{ event: { status: string; lastError: string | null; ignoredReason: string | null } }>(`/api/marketplace/events/${id}/reprocess`, { body: {} });
      if (!r.ok) throw new Error(errorText(r));
      return `Evento #${id} reprocessado: ${r.data.event?.status}${r.data.event?.lastError ? ` — ${r.data.event.lastError}` : ""}${r.data.event?.ignoredReason ? ` (${REASON_LABEL[r.data.event.ignoredReason] ?? r.data.event.ignoredReason})` : ""}.`;
    });

  const reprocessFailed = () =>
    run("failed", async () => {
      if (!window.confirm("Recolocar na fila todos os eventos com falha? Os recursos serão relidos na API do Mercado Livre (somente leitura).")) return "Cancelado.";
      const r = await api<{ requeued: number; processed: number }>("/api/marketplace/events", { body: { action: "reprocess-failed", confirm: true } });
      if (!r.ok) throw new Error(errorText(r));
      return `${r.data.requeued} evento(s) recolocado(s) na fila; ${r.data.processed} processado(s) agora.`;
    });

  const acknowledge = (id: string) =>
    run(`is-${id}`, async () => {
      const r = await api(`/api/marketplace/issues/${id}/resolve`, { body: {} });
      if (!r.ok) throw new Error(errorText(r));
      return "Divergência marcada como ciente. Ela volta a aparecer se a próxima leitura confirmar o problema.";
    });

  async function openDetail(id: string) {
    if (detail?.id === id) return setDetail(null);
    const r = await api<Record<string, unknown>>(`/api/marketplace/events/${id}`);
    if (r.ok) setDetail({ id, data: r.data });
  }

  const conn = s.connection;
  const tickAge = s.scheduler.lastTickAt ? (Date.now() - new Date(s.scheduler.lastTickAt).getTime()) / 60000 : Infinity;
  const pages = Math.max(1, Math.ceil(props.events.total / props.events.pageSize));
  const qs = (p: Record<string, string | number>) => {
    const u = new URLSearchParams();
    const merged = { status: props.filters.status, topic: props.filters.topic, ...p };
    for (const [k, v] of Object.entries(merged)) if (v !== "" && v !== undefined) u.set(k, String(v));
    return `?${u.toString()}`;
  };

  return (
    <>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}
      {s.lastAlert && (
        <div className="alert warn" role="status">
          Último alerta ({formatDateTime(s.lastAlert.at)}): {s.lastAlert.message}
        </div>
      )}

      <section className="kpis" aria-label="Resumo">
        <div className="kpi">
          <strong>
            <span className={`badge ${conn.status}`}>{conn.status === "connected" ? "Credenciais ativas" : conn.status === "reauth_required" ? "Reautorizar" : "Desconectado"}</span>
          </strong>
          <span>Conta {conn.nickname ?? "—"} ({conn.meliUserId ?? "—"})</span>
        </div>
        <div className="kpi">
          <strong>{ago(ev.lastWebhookAt)}</strong>
          <span>Última notificação recebida pelo webhook</span>
        </div>
        <div className="kpi">
          <strong>{ago(s.lastSuccessfulApiAt)}</strong>
          <span>Última comunicação bem-sucedida com a API</span>
        </div>
        <div className="kpi">
          <strong>{pending}</strong>
          <span>Pendentes{ev.oldestPendingAt ? ` · mais antigo ${ago(ev.oldestPendingAt)}` : ""}</span>
        </div>
        <div className="kpi">
          <strong>{ev.byStatus.FAILED ?? 0}</strong>
          <span>Com erro (dead-letter)</span>
        </div>
        <div className="kpi">
          <strong>{ev.byStatus.IGNORED ?? 0}</strong>
          <span>Ignorados</span>
        </div>
        <div className="kpi">
          <strong>{ev.avgProcessingMs24h ?? "—"} ms</strong>
          <span>Tempo médio de processamento (24 h){ev.avgDelayMs24h !== null ? ` · atraso médio ${Math.round(ev.avgDelayMs24h / 1000)} s` : ""}</span>
        </div>
        <div className="kpi">
          <strong>{Object.values(s.divergences).reduce((a, n) => a + n, 0)}</strong>
          <span>Divergências abertas</span>
        </div>
      </section>

      <section className="card">
        <h2>Saúde da conexão e do agendamento</h2>
        <dl className="details">
          <div>
            <dt>Conectividade</dt>
            <dd>
              Credencial guardada não prova conexão: valide agora.{" "}
              <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={testConnection}>
                {busy === "test" ? "Testando…" : "Testar conexão (/users/me)"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Renovação de token</dt>
            <dd>
              Última renovação: {formatDateTime(conn.lastRefreshedAt)}
              {conn.lastErrorCode && <span className="chip danger" style={{ marginLeft: 6 }}>falha: {conn.lastErrorCode}</span>}
            </dd>
          </div>
          <div>
            <dt>Falhas (24 h)</dt>
            <dd>
              {ev.authFailures24h} de autenticação · {ev.apiErrors24h} de consulta à API
            </dd>
          </div>
          <div>
            <dt>URL do webhook (DevCenter → Notificações)</dt>
            <dd>
              <code>{props.webhookUrl}</code>
            </dd>
          </div>
          <div>
            <dt>Status do webhook</dt>
            <dd>
              {ev.lastWebhookAt ? (
                <span className="chip ok">recebendo · última {ago(ev.lastWebhookAt)}</span>
              ) : (
                <span className="chip warn">nenhuma notificação recebida ainda — confira o cadastro no DevCenter</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Agendador (server-side)</dt>
            <dd>
              Último ciclo: {ago(s.scheduler.lastTickAt)} {s.scheduler.lastTickTrigger ? `(${s.scheduler.lastTickTrigger})` : ""}{" "}
              <span className={`chip ${tickAge < 15 ? "ok" : "warn"}`}>{tickAge < 15 ? "em dia" : "atrasado"}</span>
              <br />
              <small className="muted">
                pg_cron no banco: {s.scheduler.pgCron === "active" ? "ativo (a cada 5 min)" : s.scheduler.pgCron === "missing" ? "não instalado" : "não verificável"} · intervalos:
                anúncios {s.scheduler.intervals.listingsMin} min, pedidos {s.scheduler.intervals.ordersRecoveryMin} min, missed_feeds {s.scheduler.intervals.missedFeedsMin} min
              </small>
            </dd>
          </div>
        </dl>
        <div className="actions">
          <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null} onClick={() => runJob("LISTINGS_RECONCILE")}>
            {busy === "LISTINGS_RECONCILE" ? "Reconciliando…" : "Executar reconciliação de leitura"}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => runJob("MISSED_FEEDS")}>
            {busy === "MISSED_FEEDS" ? "Consultando…" : "Recuperar notificações perdidas"}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => runJob("ORDERS_RECOVERY")}>
            {busy === "ORDERS_RECOVERY" ? "Consultando…" : "Varrer pedidos recentes"}
          </button>
          <button className="btn btn-danger btn-sm" type="button" disabled={busy !== null || !ev.byStatus.FAILED} onClick={reprocessFailed}>
            Reprocessar todos com falha ({ev.byStatus.FAILED ?? 0})
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Rotinas periódicas</h2>
        {props.jobs.length === 0 ? (
          <p className="muted">Nenhuma execução registrada ainda.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Rotina</th>
                  <th>Origem</th>
                  <th>Início</th>
                  <th>Situação</th>
                  <th className="num">Lidos</th>
                  <th className="num">Alterados</th>
                  <th className="num">Falhas</th>
                </tr>
              </thead>
              <tbody>
                {props.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>{JOB_LABEL[j.type] ?? j.type}</td>
                    <td>{j.trigger}</td>
                    <td>{formatDateTime(j.startedAt)}</td>
                    <td>
                      <span className={`chip ${j.status === "COMPLETED" ? "ok" : j.status === "RUNNING" ? "info" : j.status === "PARTIAL" ? "warn" : "danger"}`}>{j.status}</span>
                      {j.error && <small style={{ display: "block", color: "var(--danger-fg)" }}>{j.error}</small>}
                    </td>
                    <td className="num">{j.processed}</td>
                    <td className="num">{j.changed}</td>
                    <td className="num">{j.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Divergências abertas</h2>
        {props.issues.length === 0 ? (
          <p className="muted">Nenhuma divergência entre o integrador e o Mercado Livre.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Anúncio</th>
                  <th>Tipo</th>
                  <th>Integrador</th>
                  <th>Mercado Livre</th>
                  <th>Detectada</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.issues.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.draftId ? <a href={`/anuncios/preparar/${i.draftId}`}>{i.itemId}</a> : i.itemId}
                      {i.details && typeof i.details.title === "string" && <small className="muted" style={{ display: "block" }}>{i.details.title}</small>}
                    </td>
                    <td>{ISSUE_LABEL[i.issueType] ?? i.issueType}</td>
                    <td>{i.localValue ?? "—"}</td>
                    <td>{i.remoteValue ?? "—"}</td>
                    <td>
                      {formatDateTime(i.firstDetectedAt)}
                      <small className="muted" style={{ display: "block" }}>última: {formatDateTime(i.lastDetectedAt)}</small>
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => acknowledge(i.id)}>
                        Ciente
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Histórico de eventos ({props.events.total})</h2>
        <form method="get" className="toolbar" style={{ marginBottom: 10 }}>
          <select name="status" defaultValue={props.filters.status} aria-label="Situação">
            <option value="">Todas as situações</option>
            {["PENDING", "PROCESSING", "RETRYING", "COMPLETED", "FAILED", "IGNORED"].map((st) => (
              <option key={st} value={st}>
                {st} ({ev.byStatus[st] ?? 0})
              </option>
            ))}
          </select>
          <select name="topic" defaultValue={props.filters.topic} aria-label="Tópico">
            <option value="">Todos os tópicos</option>
            {[...new Set([...s.supportedTopics, ...ev.topics.map((t) => t.topic)])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" type="submit">
            Filtrar
          </button>
        </form>
        {props.events.items.length === 0 ? (
          <p className="muted">Nenhum evento.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Recebido</th>
                  <th>Tópico</th>
                  <th>Recurso</th>
                  <th>Origem</th>
                  <th>Situação</th>
                  <th className="num">Tentativas</th>
                  <th className="num">ms</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.events.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => openDetail(e.id)} title={`correlação ${e.correlationId}`}>
                          {e.id}
                        </button>
                      </td>
                      <td>{formatDateTime(e.receivedAt)}</td>
                      <td>
                        {e.topic}
                        {e.actions?.length ? <small className="muted" style={{ display: "block" }}>{e.actions.join(", ")}</small> : null}
                      </td>
                      <td>
                        <code>{e.resource}</code>
                      </td>
                      <td>{e.source}</td>
                      <td>
                        <span className={`chip ${EVENT_TONE[e.status] ?? ""}`}>{e.status}</span>
                        {e.coalescedInto && <small className="muted" style={{ display: "block" }}>atendido pelo #{e.coalescedInto}</small>}
                        {e.ignoredReason && <small className="muted" style={{ display: "block" }}>{REASON_LABEL[e.ignoredReason] ?? e.ignoredReason}</small>}
                        {e.lastError && (
                          <small style={{ display: "block", color: "var(--danger-fg)" }} title={e.lastError}>
                            {e.lastErrorCode}
                          </small>
                        )}
                        {e.status === "RETRYING" && <small className="muted" style={{ display: "block" }}>nova tentativa {formatDateTime(e.nextAttemptAt)}</small>}
                      </td>
                      <td className="num">
                        {e.attempts}/{e.maxAttempts}
                      </td>
                      <td className="num">{e.durationMs ?? "—"}</td>
                      <td>
                        {["FAILED", "IGNORED", "COMPLETED"].includes(e.status) && (
                          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => reprocess(e.id)}>
                            {busy === `ev-${e.id}` ? "…" : "Reprocessar"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {detail?.id === e.id && (
                      <tr>
                        <td colSpan={9}>
                          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", margin: 0 }}>{JSON.stringify(detail.data, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pagination">
            <span className="muted">
              Página {props.events.page} de {pages}
            </span>
            <div className="pages">
              {props.events.page > 1 && (
                <a className="btn btn-secondary btn-sm" href={qs({ page: props.events.page - 1 })}>
                  Anterior
                </a>
              )}
              {props.events.page < pages && (
                <a className="btn btn-secondary btn-sm" href={qs({ page: props.events.page + 1 })}>
                  Próxima
                </a>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
