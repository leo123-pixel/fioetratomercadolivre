"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

type Kind = "PRICE" | "STOCK";
type Mode = "DISABLED" | "SHADOW" | "PILOT" | "AUTOMATIC" | "PAUSED";

interface Automation {
  kind: Kind;
  mode: Mode;
  resumeMode: Mode | null;
  scope: "SELECTED" | "ALL_ELIGIBLE";
  intervalMinutes: number;
  policy: Record<string, unknown>;
  automaticApprovedBy: string | null;
  automaticApprovedAt: string | null;
  pausedReason: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  version: number;
}

interface Job {
  id: string;
  kind: Kind;
  variantId: string;
  sku: string | null;
  name: string | null;
  status: string;
  mode: string;
  expectedValue: string | null;
  targetValue: string;
  observedAfter: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  verified: boolean;
  locationId: string | null;
}

interface Run {
  id: string;
  kind: Kind;
  mode: string;
  trigger: string;
  status: string;
  requestedBy: string;
  startedAt: string;
  summary: { decisions?: Record<string, number>; reason?: string; variants?: number } | null;
  errorMessage: string | null;
}

interface Data {
  store: { storeId: string; storeName: string | null; connectionStatus: string; missingPhase2Scopes: string[]; multiLocation: boolean | null } | null;
  writeEnv: { enabled: boolean; warning: string | null };
  inventoryCore: { mode: string; reason: string | null };
  emergencyStop: { active: boolean; reason: string | null; activatedBy: string | null; activatedAt: string | null };
  automations: Automation[];
  activationBlockers: Record<Kind, string[]>;
  linkedVariants: number;
  decisions: { kind: Kind; decision: string | null; n: number }[];
  participation: { kind: Kind; participation: string; n: number }[];
  jobs: { kind: Kind; status: string; n: number }[];
  runs: Run[];
  attention: Job[];
  queue: Job[];
  recent: Job[];
  blocked: { kind: Kind; variantId: string; sku: string | null; name: string | null; reasonCode: string | null; reason: string | null; target: string | null; remote: string | null; participation: string }[];
  reviews: { id: string; variantId: string; sku: string | null; name: string | null; current: string | null; target: string | null; changePct: string | null; reason: string | null }[];
  orders: { state: string; n: number }[];
  pendingOrders: { orderId: string; number: string | null; status: string | null; paymentStatus: string | null; createdAt: string | null; lines: { variantId: string | null; quantity: number; sku: string | null }[]; commitmentState: string; unmappedLines: number }[];
  orderProtection: { ready: boolean; reasons: string[]; lastReconciliationAt: string | null; webhooks: string[] } | null;
  webhooks: { registrations: { event: string; status: string; lastError: string | null }[]; queue: { pending: number; failed: number; oldestPendingAt: string | null; last24h: number } } | null;
  worker: { lastNuvemshopTick: { updatedAt: string; value: { steps?: Record<string, unknown> } } | null; lastSchedulerTickAt: string | null };
}

const MODE: Record<Mode, { text: string; tone: string; help: string }> = {
  DISABLED: { text: "Desligado", tone: "", help: "Nada roda." },
  SHADOW: { text: "SOMBRA — sem escrita", tone: "info", help: "Calcula e registra o que faria; nada é enviado à Nuvemshop." },
  PILOT: { text: "PILOTO — só SKUs do piloto", tone: "warn", help: "Escreve somente nas variantes marcadas como Piloto." },
  AUTOMATIC: { text: "AUTOMÁTICO — escrita real", tone: "ok", help: "Escreve nas variantes selecionadas (ou em todas as elegíveis) sem confirmação por execução." },
  PAUSED: { text: "PAUSADO", tone: "danger", help: "Nada é escrito até reativar." },
};

const JOB_STATUS: Record<string, string> = {
  PENDING: "na fila",
  RUNNING: "enviando",
  SUCCEEDED: "aplicado e conferido",
  FAILED: "falhou",
  UNCERTAIN: "resultado incerto",
  REQUIRES_RECONCILIATION: "aguarda reconciliação",
  SUPERSEDED: "superado (valor mudou)",
  CANCELED: "cancelado",
};

const KIND_LABEL: Record<Kind, string> = { PRICE: "Preço", STOCK: "Estoque" };
const money = (cents: string | null) => (cents === null ? "—" : `R$ ${(Number(cents) / 100).toFixed(2).replace(".", ",")}`);
const value = (kind: Kind, v: string | null) => (kind === "PRICE" ? money(v) : (v ?? "—"));

export function AutomationPanel({ data, automaticPhrase }: { data: Data; automaticPhrase: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function act(key: string, body: Record<string, unknown>, ok: (d: Record<string, unknown>) => string) {
    setBusy(key);
    setMsg(null);
    const r = await api<Record<string, unknown>>("/api/nuvemshop/automation", { method: "POST", body });
    setBusy(null);
    setMsg(r.ok ? { kind: "success", text: ok(r.data) } : { kind: "error", text: errorText(r) });
    if (r.ok) router.refresh();
  }

  const stop = data.emergencyStop;
  const lastTick = data.worker.lastNuvemshopTick;

  return (
    <>
      {msg && (
        <div className={`alert ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      {stop.active ? (
        <div className="alert error" role="alert">
          <strong>Desligamento de emergência ATIVO</strong> desde {formatDateTime(stop.activatedAt)} por {stop.activatedBy ?? "—"}: {stop.reason ?? "—"}. Nenhuma escrita é criada nem executada
          (catálogo, preço e estoque).
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={() => {
                if (window.prompt('Digite LIBERAR para liberar as escritas (as automações continuam pausadas até serem reativadas):') === "LIBERAR") act("release", { action: "release_emergency", confirmation: "LIBERAR" }, () => "Escritas liberadas. As automações continuam pausadas.");
              }}
            >
              Liberar desligamento
            </button>
          </div>
        </div>
      ) : (
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <span className="muted">
            Escrita no ambiente: {data.writeEnv.enabled ? <span className="chip ok">ligada</span> : <span className="chip warn">desligada</span>} · Inventory Core:{" "}
            <span className={`chip ${data.inventoryCore.mode === "shadow" ? "ok" : "warn"}`}>{data.inventoryCore.mode}</span> · Último ciclo Nuvemshop: {formatDateTime(lastTick?.updatedAt ?? null)} · Último tick do agendador:{" "}
            {formatDateTime(data.worker.lastSchedulerTickAt)}
          </span>
          <button
            className="btn btn-danger-solid"
            disabled={busy !== null}
            onClick={() => {
              const reason = window.prompt("Motivo do desligamento de emergência (para todas as escritas e cancela a fila):");
              if (reason && reason.trim().length >= 3) act("stop", { action: "emergency_stop", reason }, (d) => `Desligamento ativado. ${d.canceled ?? 0} escrita(s) na fila cancelada(s).`);
            }}
          >
            Pausa emergencial
          </button>
        </div>
      )}
      {!data.writeEnv.enabled && <div className="alert info">{data.writeEnv.warning}. Simulações e o modo sombra funcionam; piloto e automático exigem NUVEMSHOP_WRITE_ENABLED=true.</div>}
      {data.store?.missingPhase2Scopes.length ? <div className="alert warn">A loja não concedeu: {data.store.missingPhase2Scopes.join(", ")}. Ajuste os escopos do aplicativo e reconecte a loja.</div> : null}
      {!data.store && <div className="empty-state">Nenhuma loja Nuvemshop conectada.</div>}

      <div className="row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
        {data.automations.map((a) => (
          <AutomationCard key={a.kind} a={a} data={data} busy={busy} act={act} automaticPhrase={automaticPhrase} />
        ))}
      </div>

      <OrdersSection data={data} busy={busy} act={act} />
      <Participants busy={busy} act={act} />

      {data.reviews.length > 0 && (
        <section className="card">
          <h2>Preços aguardando revisão</h2>
          <p className="hint">Variação acima do limite ou primeira definição de preço: só é aplicada com aprovação (escrita manual com conferência).</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Variante</th>
                  <th>Atual</th>
                  <th>Tabela ADS</th>
                  <th>Novo</th>
                  <th>Variação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr>
                    <td>
                      {r.name ?? "—"} <small className="muted">{r.sku ?? r.variantId}</small>
                    </td>
                    <td>{money(r.current)}</td>
                    <td>{money((r as { base?: string | null }).base ?? null)}</td>
                    <td>{money(r.target)}</td>
                    <td>{r.changePct ? `${r.changePct}%` : "—"}</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act(`approve-${r.id}`, { action: "approve_price", itemId: r.id }, () => "Aprovado: escrita enfileirada (será conferida por leitura).")}>
                        Aprovar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="status-row">
          <h2 style={{ margin: 0 }}>Divergências, incertos e erros</h2>
          <div className="toolbar">
            <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act("uncertain", { action: "reconcile", target: "uncertain" }, (d) => `Conferidos: ${d.resolved ?? 0} resolvido(s), ${d.reconciliation ?? 0} em reconciliação.`)}>
              Conferir incertos agora
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act("writer", { action: "reconcile", target: "writer" }, (d) => `Fila processada: ${d.succeeded ?? 0} aplicada(s), ${d.failed ?? 0} falha(s), ${d.superseded ?? 0} superada(s).`)}>
              Processar fila agora
            </button>
          </div>
        </div>
        <JobTable jobs={data.attention} empty="Nenhuma divergência ou erro." onResolve={(j) => {
          const note = window.prompt(`Conferiu a variante ${j.variantId} na Nuvemshop? Descreva a decisão (libera a variante para o próximo ciclo):`);
          if (note && note.trim().length >= 3) act(`resolve-${j.id}`, { action: "resolve_job", jobId: j.id, note }, () => "Reconciliado: a próxima execução recalcula a partir do valor lido.");
        }} />
      </section>

      {data.blocked.length > 0 && (
        <section className="card">
          <h2>Variantes bloqueadas ou em revisão (última avaliação)</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Variante</th>
                  <th>Na loja</th>
                  <th>Alvo</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {data.blocked.map((b) => (
                  <tr key={`${b.kind}-${b.variantId}`}>
                    <td>{KIND_LABEL[b.kind]}</td>
                    <td>
                      {b.name ?? "—"} <small className="muted">{b.sku ?? b.variantId}</small>
                    </td>
                    <td>{value(b.kind, b.remote)}</td>
                    <td>{value(b.kind, b.target)}</td>
                    <td>
                      <span className="chip warn">{b.reasonCode ?? "—"}</span> <small>{b.reason}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Fila de escritas</h2>
        <JobTable jobs={data.queue} empty="Fila vazia." />
        <h3>Últimas escritas</h3>
        <JobTable jobs={data.recent} empty="Nenhuma escrita ainda." />
      </section>

      <RunsSection runs={data.runs} />
    </>
  );
}

function AutomationCard({ a, data, busy, act, automaticPhrase }: { a: Automation; data: Data; busy: string | null; act: (k: string, b: Record<string, unknown>, ok: (d: Record<string, unknown>) => string) => void; automaticPhrase: string }) {
  const m = MODE[a.mode];
  const counts = (list: { kind: Kind; n: number }[], key: "decision" | "participation") =>
    Object.fromEntries(list.filter((x) => x.kind === a.kind).map((x) => [(x as unknown as Record<string, string>)[key] ?? "—", x.n]));
  const dec = counts(data.decisions, "decision");
  const part = counts(data.participation, "participation");
  const blockers = data.activationBlockers[a.kind];
  const [interval, setIntervalMin] = useState(a.intervalMinutes);
  const [scope, setScope] = useState(a.scope);
  const [policy, setPolicy] = useState<Record<string, unknown>>(a.policy);
  const setMode = (mode: Mode) => {
    if (mode === "AUTOMATIC") {
      const confirmation = window.prompt(`Ativar o modo AUTOMÁTICO de ${KIND_LABEL[a.kind].toLowerCase()} (escrita real sem confirmação por execução). Digite: ${automaticPhrase}`);
      if (!confirmation) return;
      return act(`mode-${a.kind}`, { action: "set_mode", kind: a.kind, mode, confirmation }, () => "Modo automático aprovado e ativado.");
    }
    act(`mode-${a.kind}`, { action: "set_mode", kind: a.kind, mode }, () => `Modo alterado para ${MODE[mode].text}.`);
  };
  const field = (k: string, label: string, type: "number" | "text" = "number", step = "1") => (
    <label>
      {label}
      <input
        type={type}
        step={step}
        value={policy[k] === null || policy[k] === undefined ? "" : String(policy[k])}
        onChange={(e) => setPolicy({ ...policy, [k]: e.target.value === "" ? null : type === "number" ? Number(e.target.value) : e.target.value })}
      />
    </label>
  );
  return (
    <section className="card">
      <div className="status-row">
        <h2 style={{ margin: 0 }}>{KIND_LABEL[a.kind]}</h2>
        <span className={`chip ${m.tone}`} style={{ fontSize: "0.85rem" }}>
          {m.text}
        </span>
      </div>
      <p className="hint">{m.help}{a.mode === "PAUSED" && a.pausedReason ? ` Motivo: ${a.pausedReason}.` : ""}{a.mode === "AUTOMATIC" && a.automaticApprovedBy ? ` Aprovado por ${a.automaticApprovedBy} em ${formatDateTime(a.automaticApprovedAt)}.` : ""}</p>
      <dl className="details">
        <div>
          <dt>Última execução</dt>
          <dd>{formatDateTime(a.lastRunAt)}</dd>
        </div>
        <div>
          <dt>Próxima execução</dt>
          <dd>{["SHADOW", "PILOT", "AUTOMATIC"].includes(a.mode) ? formatDateTime(a.nextRunAt) : "—"}</dd>
        </div>
        <div>
          <dt>Variantes vinculadas</dt>
          <dd>{data.linkedVariants}</dd>
        </div>
        <div>
          <dt>Piloto / incluídas / excluídas</dt>
          <dd>
            {part.PILOT ?? 0} / {part.INCLUDED ?? 0} / {part.EXCLUDED ?? 0}
          </dd>
        </div>
        <div>
          <dt>Em sincronia / a escrever / bloqueadas</dt>
          <dd>
            {dec.IN_SYNC ?? 0} / {(dec.WRITE ?? 0) + (dec.SHADOW ?? 0)} / {(dec.BLOCKED ?? 0) + (dec.REVIEW ?? 0)}
          </dd>
        </div>
      </dl>
      {blockers.length > 0 && (
        <div className="alert warn" style={{ marginTop: 8 }}>
          Para PILOTO/AUTOMÁTICO falta: {blockers.join("; ")}.
        </div>
      )}
      <div className="toolbar" style={{ marginTop: 12, flexWrap: "wrap" }}>
        {(["DISABLED", "SHADOW", "PILOT", "AUTOMATIC"] as Mode[]).map((mode) => (
          <button key={mode} className={`btn btn-sm ${a.mode === mode ? "btn-primary" : "btn-secondary"}`} disabled={busy !== null || a.mode === mode} onClick={() => setMode(mode)}>
            {mode === "DISABLED" ? "Desligar" : mode === "SHADOW" ? "Sombra" : mode === "PILOT" ? "Piloto" : "Automático"}
          </button>
        ))}
        {a.mode === "PAUSED" ? (
          <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act(`resume-${a.kind}`, { action: "resume", kind: a.kind }, () => "Automação reativada.")}>
            Reativar ({a.resumeMode})
          </button>
        ) : a.mode !== "DISABLED" ? (
          <button
            className="btn btn-danger btn-sm"
            disabled={busy !== null}
            onClick={() => {
              const reason = window.prompt("Motivo da pausa:");
              if (reason && reason.trim().length >= 3) act(`pause-${a.kind}`, { action: "pause", kind: a.kind, reason }, () => "Automação pausada; escritas não iniciadas foram canceladas.");
            }}
          >
            Pausar
          </button>
        ) : null}
        <button
          className="btn btn-secondary btn-sm"
          disabled={busy !== null}
          onClick={() =>
            act(`sim-${a.kind}`, { action: "simulate", kind: a.kind }, (d) => {
              const s = d.summary as { decisions?: Record<string, number>; reason?: string; variants?: number } | undefined;
              if (d.status === "SKIPPED") return `Simulação não executada: ${s?.reason ?? ""}`;
              const x = s?.decisions ?? {};
              return `Simulação (nada escrito): ${s?.variants ?? 0} variante(s) — ${x.SHADOW ?? 0} mudariam, ${x.IN_SYNC ?? 0} em sincronia, ${(x.BLOCKED ?? 0) + (x.REVIEW ?? 0)} bloqueada(s)/revisão.`;
            })
          }
        >
          {busy === `sim-${a.kind}` ? "Simulando…" : "Executar simulação"}
        </button>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary>Frequência, escopo e limites</summary>
        <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
          <label>
            Intervalo (min)
            <input type="number" min={5} max={1440} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))} />
          </label>
          <label>
            Escopo do automático
            <select value={scope} onChange={(e) => setScope(e.target.value as Automation["scope"])}>
              <option value="SELECTED">Só variantes selecionadas</option>
              <option value="ALL_ELIGIBLE">Todas as elegíveis</option>
            </select>
          </label>
          {a.kind === "PRICE" ? (
            <>
              {field("priceTableCode", "Tabela ADS", "text")}
              {field("branchId", "Filial (vazio = menor)", "text")}
              {field("marginPct", "Margem adicional (%)", "number", "0.01")}
              {field("minPrice", "Preço mínimo (R$)", "number", "0.01")}
              {field("maxChangePct", "Variação máx. sem revisão (%)", "number", "0.1")}
              {field("cacheMaxAgeHours", "Idade máx. do preço gravado (h)")}
              <label>
                Arredondamento
                <select value={String(policy.rounding)} onChange={(e) => setPolicy({ ...policy, rounding: e.target.value })}>
                  <option value="NONE">Nenhum</option>
                  <option value="CENTS_90">Termina em ,90</option>
                  <option value="CENTS_99">Termina em ,99</option>
                  <option value="WHOLE">Inteiro acima</option>
                </select>
              </label>
              <label>
                Preço promocional
                <select value={String(policy.promotion)} onChange={(e) => setPolicy({ ...policy, promotion: e.target.value })}>
                  <option value="BLOCK">Não mexer em variante em promoção</option>
                  <option value="KEEP">Atualizar preço cheio e manter a promoção</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                Compromisso do pedido
                <select value={String(policy.orderCommitMoment)} onChange={(e) => setPolicy({ ...policy, orderCommitMoment: e.target.value })}>
                  <option value="CREATED">Na criação (recomendado)</option>
                  <option value="PAID">No pagamento</option>
                </select>
              </label>
              {field("unconfirmedOrderGraceHours", "Prazo p/ baixa ADS (h)")}
              {field("orderReconcileMinutes", "Reconciliação de pedidos (min)")}
              {field("maxWritesPerRun", "Máx. escritas por execução")}
            </>
          )}
        </div>
        <button
          className="btn btn-secondary btn-sm"
          style={{ marginTop: 8 }}
          disabled={busy !== null}
          onClick={() => act(`settings-${a.kind}`, { action: "settings", kind: a.kind, patch: { expectedVersion: a.version, intervalMinutes: interval, scope, policy } }, () => "Configuração salva.")}
        >
          Salvar configuração
        </button>
        {a.kind === "STOCK" && <p className="hint">A cota publicável (reserva de segurança, percentuais, cotas fixas, mínimos e máximos por canal) é configurada no <a href="/estoque/controle-central?aba=configuracao">Estoque central</a>: o conector Nuvemshop não calcula cota.</p>}
      </details>
    </section>
  );
}

function JobTable({ jobs, empty, onResolve }: { jobs: Job[]; empty: string; onResolve?: (j: Job) => void }) {
  if (!jobs.length) return <div className="empty-state">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Quando</th>
            <th>Tipo</th>
            <th>Variante</th>
            <th>Antes → alvo</th>
            <th>Lido depois</th>
            <th>Situação</th>
            {onResolve && <th />}
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                <small>{formatDateTime(j.createdAt)}</small>
              </td>
              <td>
                {KIND_LABEL[j.kind]} <small className="muted">{j.mode}</small>
              </td>
              <td>
                {j.name ?? "—"} <small className="muted">{j.sku ?? j.variantId}{j.locationId ? ` · ${j.locationId}` : ""}</small>
              </td>
              <td>
                {value(j.kind, j.expectedValue)} → {value(j.kind, j.targetValue)}
              </td>
              <td>{value(j.kind, j.observedAfter)}</td>
              <td>
                <span className={`chip ${j.status === "SUCCEEDED" ? "ok" : j.status === "PENDING" || j.status === "RUNNING" ? "info" : j.status === "SUPERSEDED" || j.status === "CANCELED" ? "" : "danger"}`}>{JOB_STATUS[j.status] ?? j.status}</span>
                {j.errorMessage && <small className="muted"> {j.errorMessage}</small>}
              </td>
              {onResolve && (
                <td>
                  {(j.status === "REQUIRES_RECONCILIATION" || j.status === "UNCERTAIN") && (
                    <button className="btn btn-secondary btn-sm" onClick={() => onResolve(j)}>
                      Reconciliar
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrdersSection({ data, busy, act }: { data: Data; busy: string | null; act: (k: string, b: Record<string, unknown>, ok: (d: Record<string, unknown>) => string) => void }) {
  const p = data.orderProtection;
  const counts = Object.fromEntries(data.orders.map((o) => [o.state, o.n]));
  return (
    <section className="card">
      <div className="status-row">
        <h2 style={{ margin: 0 }}>Proteção de pedidos pendentes</h2>
        {p && <span className={`chip ${p.ready ? "ok" : "danger"}`}>{p.ready ? "operante" : "não operante — aumentos bloqueados"}</span>}
      </div>
      <p className="hint">
        Pedidos Nuvemshop viram compromissos no Inventory Core (descontados do saldo ADS) até a baixa ser confirmada na ADS ou o pedido ser cancelado. Nenhum pedido é enviado à ADS nesta
        fase e nenhum dado pessoal do comprador é guardado.
      </p>
      {p && !p.ready && <div className="alert warn">{p.reasons.join("; ")}.</div>}
      <dl className="details">
        <div>
          <dt>Pendentes de baixa ADS</dt>
          <dd>{(counts.COMMITTED ?? 0) + (counts.REQUIRES_RECONCILIATION ?? 0)}</dd>
        </div>
        <div>
          <dt>Baixa confirmada / liberados</dt>
          <dd>
            {counts.REFLECTED_IN_ERP ?? 0} / {counts.RELEASED ?? 0}
          </dd>
        </div>
        <div>
          <dt>Última reconciliação</dt>
          <dd>{formatDateTime(p?.lastReconciliationAt ?? null)}</dd>
        </div>
        <div>
          <dt>Webhooks</dt>
          <dd>
            {data.webhooks?.registrations.filter((r) => r.status === "ACTIVE").length ?? 0} ativos · fila {data.webhooks?.queue.pending ?? 0} · falhas 7d {data.webhooks?.queue.failed ?? 0}
          </dd>
        </div>
      </dl>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act("hooks", { action: "register_webhooks" }, (d) => `Webhooks: ${(d.created as string[]).length} criado(s), ${(d.existing as string[]).length} já existiam${(d.failed as unknown[]).length ? `, ${(d.failed as unknown[]).length} falha(s)` : ""}.`)}>
          Cadastrar webhooks
        </button>
        <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act("orders", { action: "reconcile", target: "orders" }, (d) => `Reconciliação: ${d.orders ?? 0} pedido(s) relidos${d.complete ? "" : " (continua no próximo ciclo)"}.`)}>
          Reconciliar pedidos agora
        </button>
        <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => act("catalog", { action: "reconcile", target: "catalog" }, () => "Releitura incremental do catálogo enfileirada.")}>
          Reconciliar catálogo
        </button>
      </div>
      {data.pendingOrders.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Criado</th>
                <th>Situação</th>
                <th>Itens</th>
                <th>Compromisso</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.pendingOrders.map((o) => (
                <tr key={o.orderId}>
                  <td>
                    #{o.number ?? "—"} <small className="muted">{o.orderId}</small>
                  </td>
                  <td>
                    <small>{formatDateTime(o.createdAt)}</small>
                  </td>
                  <td>
                    {o.status} · {o.paymentStatus}
                  </td>
                  <td>
                    <small>{o.lines.map((l) => `${l.quantity}× ${l.sku ?? l.variantId}`).join(", ")}</small>
                    {o.unmappedLines > 0 && <span className="chip danger"> {o.unmappedLines} sem vínculo</span>}
                  </td>
                  <td>
                    <span className={`chip ${o.commitmentState === "COMMITTED" ? "warn" : o.commitmentState === "REQUIRES_RECONCILIATION" ? "danger" : ""}`}>{o.commitmentState}</span>
                  </td>
                  <td>
                    {(o.commitmentState === "COMMITTED" || o.commitmentState === "REQUIRES_RECONCILIATION") && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy !== null}
                        onClick={() => {
                          const reference = window.prompt(`Confirme que a venda do pedido #${o.number ?? o.orderId} JÁ FOI BAIXADA na ADS (o compromisso deixa de ser descontado). Referência na ADS (opcional):`, "");
                          if (reference !== null) act(`ads-${o.orderId}`, { action: "confirm_ads", orderId: o.orderId, reference: reference || null }, () => "Baixa ADS confirmada: compromisso encerrado sem baixa dupla.");
                        }}
                      >
                        Baixa ADS confirmada
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface VariantRow {
  variantId: string;
  sku: string | null;
  name: string | null;
  price: string | null;
  stock: number | null;
  adsProductId: number;
  participation: string;
  lastDecision: string | null;
  lastReason: string | null;
  lastWritten: string | null;
  lastWrittenAt: string | null;
}

function Participants({ busy, act }: { busy: string | null; act: (k: string, b: Record<string, unknown>, ok: (d: Record<string, unknown>) => string) => void }) {
  const [kind, setKind] = useState<Kind>("STOCK");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<VariantRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const load = async (k = kind) => {
    const r = await api<{ items: VariantRow[] }>(`/api/nuvemshop/automation/variants?kind=${k}&q=${encodeURIComponent(q)}`);
    if (r.ok) {
      setRows(r.data.items);
      setSelected(new Set());
      setError(null);
    } else setError(errorText(r));
  };
  const apply = (participation: string) =>
    act(`part-${participation}`, { action: "participation", kind, variantIds: [...selected], participation }, (d) => {
      void load();
      return `${d.updated ?? 0} variante(s) atualizada(s).`;
    });
  return (
    <section className="card">
      <h2>SKUs participantes</h2>
      <p className="hint">Piloto: só estas variantes recebem escrita no modo PILOTO. Incluídas: entram no AUTOMÁTICO com escopo “selecionadas”. Excluídas: nunca recebem escrita.</p>
      <div className="toolbar">
        <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setRows(null); }} aria-label="Automação">
          <option value="STOCK">Estoque</option>
          <option value="PRICE">Preço</option>
        </select>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU, nome ou ID da variante" aria-label="Busca" style={{ maxWidth: 280 }} />
        <button className="btn btn-secondary btn-sm" onClick={() => load()}>
          Buscar
        </button>
        {selected.size > 0 && (
          <>
            <span className="muted">{selected.size} selecionada(s):</span>
            {[["PILOT", "Piloto"], ["INCLUDED", "Incluir"], ["EXCLUDED", "Excluir"], ["NONE", "Remover marcação"]].map(([p, label]) => (
              <button key={p} className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => apply(p)}>
                {label}
              </button>
            ))}
          </>
        )}
      </div>
      {error && <div className="alert error">{error}</div>}
      {rows && (rows.length === 0 ? <div className="empty-state">Nenhuma variante vinculada encontrada.</div> : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th />
                <th>Variante</th>
                <th>ADS</th>
                <th>{kind === "PRICE" ? "Preço" : "Estoque"} na loja</th>
                <th>Participação</th>
                <th>Última decisão</th>
                <th>Última escrita</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.variantId}>
                  <td>
                    <input type="checkbox" aria-label={`Selecionar ${r.variantId}`} checked={selected.has(r.variantId)} onChange={(e) => { const s = new Set(selected); if (e.target.checked) s.add(r.variantId); else s.delete(r.variantId); setSelected(s); }} />
                  </td>
                  <td>
                    {r.name ?? "—"} <small className="muted">{r.sku ?? "sem SKU"} · {r.variantId}</small>
                  </td>
                  <td>#{r.adsProductId}</td>
                  <td>{kind === "PRICE" ? (r.price ?? "—") : (r.stock ?? "—")}</td>
                  <td>
                    <span className={`chip ${r.participation === "PILOT" ? "warn" : r.participation === "INCLUDED" ? "ok" : r.participation === "EXCLUDED" ? "danger" : ""}`}>{r.participation}</span>
                  </td>
                  <td>
                    {r.lastDecision ?? "—"} <small className="muted">{r.lastReason}</small>
                  </td>
                  <td>
                    <small>{r.lastWritten ? `${kind === "PRICE" ? money(r.lastWritten) : r.lastWritten} em ${formatDateTime(r.lastWrittenAt)}` : "—"}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function RunsSection({ runs }: { runs: Run[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ items: { id: string; variantId: string; sku: string | null; current: string | null; target: string | null; decision: string; reasonCode: string | null; reason: string | null; jobStatus: string | null; details: { priceSource?: string; priceFetchedAt?: string | null } | null }[] } | null>(null);
  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setDetail(null);
    const r = await api<{ items: [] }>(`/api/nuvemshop/automation/runs/${id}`);
    if (r.ok) setDetail(r.data as never);
  };
  return (
    <section className="card">
      <h2>Histórico de execuções</h2>
      {!runs.length ? (
        <div className="empty-state">Nenhuma execução ainda.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Início</th>
                <th>Tipo</th>
                <th>Modo</th>
                <th>Situação</th>
                <th>Resumo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>
                      <small>{formatDateTime(r.startedAt)}</small>
                    </td>
                    <td>{KIND_LABEL[r.kind]}</td>
                    <td>
                      <span className={`chip ${r.mode === "AUTOMATIC" ? "ok" : r.mode === "PILOT" ? "warn" : "info"}`}>{r.mode}</span> <small className="muted">{r.trigger}</small>
                    </td>
                    <td>{r.status}</td>
                    <td>
                      <small>
                        {r.errorMessage ?? r.summary?.reason ?? Object.entries(r.summary?.decisions ?? {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ")}
                      </small>
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => toggle(r.id)}>
                        {open === r.id ? "Fechar" : "Detalhes"}
                      </button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr key={`${r.id}-d`}>
                      <td colSpan={6}>
                        {!detail ? (
                          <span className="muted">Carregando…</span>
                        ) : (
                          <table>
                            <tbody>
                              {detail.items.map((i) => (
                                <tr key={i.id}>
                                  <td>{i.sku ?? i.variantId}</td>
                                  <td>
                                    {value(r.kind, i.current)} → {value(r.kind, i.target)}
                                  </td>
                                  <td>
                                    {i.decision}
                                    {i.details?.priceSource && (
                                      <small className="muted"> · {i.details.priceSource === "LIVE" ? "ADS ao vivo" : `banco (lido em ${formatDateTime(i.details.priceFetchedAt ?? null)})`}</small>
                                    )}
                                  </td>
                                  <td>
                                    <small>
                                      {i.reasonCode} {i.reason}
                                    </small>
                                  </td>
                                  <td>{i.jobStatus ? JOB_STATUS[i.jobStatus] ?? i.jobStatus : ""}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
