"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

interface Proposal {
  id: string;
  poolKey: string;
  marketplaceItemIds: string[];
  title: string | null;
  stockModel: string;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  adsQuantity: string | null;
  safetyReserve: number | null;
  pendingOrders: string | null;
  marketplaceQuantity: number | null;
  proposedQuantity: number | null;
  difference: number | null;
  direction: "INCREASE" | "DECREASE" | "NONE" | null;
  status: string;
  createdAt: string;
}

interface Job {
  id: string;
  poolKey: string;
  syncMode: string;
  status: string;
  authorizedBy: string;
  stockModel: string | null;
  targetQuantity: number;
  beforeQuantity: number | null;
  appliedQuantity: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  title: string | null;
  itemIds: string[] | null;
}

interface ValidationItem {
  proposalId: string;
  itemIds: string[];
  title: string | null;
  stockModel: string;
  marketplaceQuantity: number | null;
  proposedQuantity: number | null;
  freshMarketplaceQuantity: number | null;
  freshProposedQuantity: number | null;
  ok: boolean;
  reason: string | null;
}

const MODEL_LABEL: Record<string, string> = {
  CLASSIC: "convencional",
  CLASSIC_VARIATION: "variação",
  UP_SHARED_ITEM: "User Product",
  UP_SELLING_ADDRESS: "multiorigem (selling_address)",
  MULTI_WAREHOUSE: "depósitos do vendedor",
  FULFILLMENT: "Full",
  UNKNOWN: "—",
};

const JOB_TONE: Record<string, string> = { SUCCEEDED: "ok", QUEUED: "info", RUNNING: "info", DIVERGED: "danger", FAILED: "danger", STALE: "warn", SKIPPED: "" };
const JOB_LABEL: Record<string, string> = {
  SUCCEEDED: "aplicado e conferido",
  QUEUED: "na fila",
  RUNNING: "executando",
  DIVERGED: "não refletido no ML",
  FAILED: "falhou",
  STALE: "não enviado (proposta mudou)",
  SKIPPED: "ignorado",
};

export function SyncPanel(props: { run: { id: string; status: string; startedAt: string; requestedBy: string } | null; proposals: Proposal[]; jobs: Job[]; stockSourceConfirmed: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn" | "info"; text: string } | null>(null);
  const [validation, setValidation] = useState<{ items: ValidationItem[]; blockers: string[]; confirmationToken: string | null; expiresAt: string | null } | null>(null);
  const [agree, setAgree] = useState(false);
  const [showIneligible, setShowIneligible] = useState(false);

  const actionable = props.proposals.filter((p) => p.status === "PROPOSED");
  const visible = showIneligible ? props.proposals : props.proposals.filter((p) => p.eligible);

  async function simulateAll() {
    setBusy("simulate");
    setValidation(null);
    const r = await api<{ summary: Record<string, number>; status: string }>("/api/stock-sync/preview", { method: "POST", body: {} });
    setBusy(null);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    const s = r.data.summary;
    setFeedback({
      kind: "success",
      text: `Simulação ${r.data.status === "PARTIAL" ? "parcial (tempo esgotado; simule de novo para continuar) " : ""}concluída sem alterar o Mercado Livre: ${s.decrease ?? 0} redução(ões), ${s.increase ?? 0} aumento(s), ${s.inSync ?? 0} já em dia, ${s.ineligible ?? 0} não elegível(is).`,
    });
    setSelected(new Set());
    router.refresh();
  }

  async function validate() {
    setBusy("validate");
    setAgree(false);
    const r = await api<{ items: ValidationItem[]; blockers: string[]; confirmationToken: string | null; expiresAt: string | null }>("/api/stock-sync/validate", {
      method: "POST",
      body: { proposalIds: [...selected] },
    });
    setBusy(null);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    setValidation(r.data);
  }

  async function apply() {
    if (!validation?.confirmationToken) return;
    const ids = validation.items.filter((i) => i.ok).map((i) => i.proposalId);
    setBusy("apply");
    const r = await api<{ jobs: Job[]; skipped: { proposalId: string; reason: string }[] }>("/api/stock-sync/apply", {
      method: "POST",
      body: { proposalIds: ids, confirmationToken: validation.confirmationToken, confirm: true },
    });
    setBusy(null);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    const counts = r.data.jobs.reduce<Record<string, number>>((a, j) => ({ ...a, [j.status]: (a[j.status] ?? 0) + 1 }), {});
    setFeedback({
      kind: counts.FAILED || counts.DIVERGED ? "warn" : "success",
      text: `Resultado: ${Object.entries(counts)
        .map(([k, n]) => `${n} ${JOB_LABEL[k] ?? k}`)
        .join(", ")}${r.data.skipped.length ? `; ${r.data.skipped.length} não enviada(s)` : ""}. Cada quantidade foi conferida no Mercado Livre depois da escrita.`,
    });
    setValidation(null);
    setSelected(new Set());
    router.refresh();
  }

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
    setValidation(null);
  };

  return (
    <section aria-label="Sincronização de estoque" style={{ marginBottom: 24 }}>
      <div className="toolbar" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Simulação e sincronização de estoque</h2>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={simulateAll}>
          {busy === "simulate" ? "Simulando…" : "Simular atualização (todos os vinculados)"}
        </button>
      </div>
      {!props.stockSourceConfirmed && (
        <div className="alert warn">
          A aplicação está bloqueada até a confirmação, nas configurações abaixo, de que o saldo da ADS corresponde ao estoque efetivamente vendável. A simulação funciona
          normalmente.
        </div>
      )}
      {feedback && <div className={`alert ${feedback.kind}`}>{feedback.text}</div>}
      {!props.run ? (
        <div className="card empty-state">Nenhuma simulação ainda. A simulação consulta a ADS e o Mercado Livre e não altera nada.</div>
      ) : (
        <>
          <p className="muted">
            Simulação de {formatDateTime(props.run.startedAt)} por {props.run.requestedBy} ({props.run.status}) · {actionable.length} proposta(s) aplicável(is).{" "}
            <label style={{ display: "inline", fontWeight: 400 }}>
              <input type="checkbox" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} /> mostrar não elegíveis
            </label>
          </p>
          {selected.size > 0 && (
            <div className="bulkbar">
              <span>{selected.size} proposta(s) selecionada(s)</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={validate}>
                {busy === "validate" ? "Reconsultando ADS e ML…" : "Validar seleção"}
              </button>
            </div>
          )}
          {validation && (
            <div className="confirm-box" style={{ marginBottom: 12 }}>
              <p>
                <strong>Resumo da operação</strong> (ADS e Mercado Livre reconsultados agora):
              </p>
              <ul>
                {validation.items.map((i) => (
                  <li key={i.proposalId}>
                    {i.itemIds.join(", ")} — {i.title ?? ""}: {i.freshMarketplaceQuantity ?? i.marketplaceQuantity} → <strong>{i.proposedQuantity}</strong> ({MODEL_LABEL[i.stockModel] ?? i.stockModel}){" "}
                    {i.ok ? <span className="chip ok">ok</span> : <span className="chip warn">{i.reason}</span>}
                  </li>
                ))}
              </ul>
              {validation.blockers.map((b) => (
                <div key={b} className="alert error" style={{ marginBottom: 8 }}>
                  {b}
                </div>
              ))}
              {validation.confirmationToken && (
                <>
                  <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
                    <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                    Confirmo a atualização da quantidade disponível destes {validation.items.filter((i) => i.ok).length} anúncio(s) no Mercado Livre. Preço, título, imagens e
                    descrição não são alterados.
                  </label>
                  <div className="actions">
                    <button type="button" className="btn btn-danger-solid btn-sm" disabled={!agree || !!busy} onClick={apply}>
                      {busy === "apply" ? "Sincronizando…" : "Sincronizar estoque selecionado"}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setValidation(null)}>
                      Cancelar
                    </button>
                  </div>
                  <p className="hint">Confirmação válida até {formatDateTime(validation.expiresAt)}.</p>
                </>
              )}
            </div>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todas as propostas aplicáveis"
                      checked={actionable.length > 0 && actionable.every((p) => selected.has(p.id))}
                      onChange={(e) => {
                        setSelected(e.target.checked ? new Set(actionable.map((p) => p.id)) : new Set());
                        setValidation(null);
                      }}
                    />
                  </th>
                  <th>Anúncio(s)</th>
                  <th>Modelo</th>
                  <th className="num">ADS</th>
                  <th className="num">Reserva</th>
                  <th className="num">Pedidos pendentes</th>
                  <th className="num">ML atual</th>
                  <th className="num">Proposta</th>
                  <th className="num">Diferença</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id} className={selected.has(p.id) ? "selected" : undefined}>
                    <td>{p.status === "PROPOSED" && <input type="checkbox" aria-label={`Selecionar proposta ${p.id}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />}</td>
                    <td className="cell-name">
                      {p.marketplaceItemIds.join(", ")}
                      <small>{p.title ?? p.poolKey}</small>
                    </td>
                    <td>{MODEL_LABEL[p.stockModel] ?? p.stockModel}</td>
                    <td className="num">{p.adsQuantity ?? "—"}</td>
                    <td className="num">{p.safetyReserve ?? "—"}</td>
                    <td className="num">{p.pendingOrders ?? "—"}</td>
                    <td className="num">{p.marketplaceQuantity ?? "—"}</td>
                    <td className="num">
                      <strong>{p.proposedQuantity ?? "—"}</strong>
                    </td>
                    <td className="num">{p.difference === null ? "—" : p.difference > 0 ? `+${p.difference}` : p.difference}</td>
                    <td>
                      {p.eligible ? (
                        <span className={`chip ${p.direction === "NONE" ? "ok" : p.status === "PROPOSED" ? "info" : ""}`}>
                          {p.direction === "NONE" ? "em dia" : p.status === "PROPOSED" ? (p.direction === "INCREASE" ? "aumentar" : "reduzir") : p.status.toLowerCase()}
                        </span>
                      ) : (
                        <span className="chip warn" title={p.reasonCode ?? undefined}>
                          não elegível
                        </span>
                      )}
                      {p.reason && <small className="muted" style={{ display: "block", maxWidth: 320 }}>{p.reason}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h3 style={{ marginTop: 20 }}>Últimas atualizações</h3>
      {!props.jobs.length ? (
        <p className="muted">Nenhuma atualização de estoque feita até agora.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Anúncio(s)</th>
                <th>Modo</th>
                <th className="num">Antes</th>
                <th className="num">Alvo</th>
                <th className="num">Conferido</th>
                <th>Resultado</th>
                <th>Autorizado por</th>
              </tr>
            </thead>
            <tbody>
              {props.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{formatDateTime(j.completedAt ?? j.createdAt)}</td>
                  <td className="cell-name">
                    {(j.itemIds ?? [j.poolKey]).join(", ")}
                    <small>{j.title ?? ""}</small>
                    {j.statusBefore !== j.statusAfter && j.statusAfter && <small>Status: {j.statusBefore} → {j.statusAfter}</small>}
                  </td>
                  <td>{j.syncMode === "AUTO" ? "automático" : "manual"}</td>
                  <td className="num">{j.beforeQuantity ?? "—"}</td>
                  <td className="num">{j.targetQuantity}</td>
                  <td className="num">{j.appliedQuantity ?? "—"}</td>
                  <td>
                    <span className={`chip ${JOB_TONE[j.status] ?? ""}`}>{JOB_LABEL[j.status] ?? j.status}</span>
                    {j.errorMessage && <small className="muted" style={{ display: "block", maxWidth: 320 }}>{j.errorMessage}</small>}
                  </td>
                  <td>{j.authorizedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
