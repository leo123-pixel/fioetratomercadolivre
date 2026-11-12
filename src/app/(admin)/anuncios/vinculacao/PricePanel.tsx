"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime, formatMoney } from "@/lib/format";

interface Proposal {
  id: string;
  marketplaceItemId: string;
  title: string | null;
  variationIds: string[];
  adsProductIds: number[];
  branchId: string | null;
  adsPrice: string | null;
  marketplaceStatus: string | null;
  marketplacePrice: string | null;
  proposedPrice: string | null;
  difference: string | null;
  changePct: string | null;
  largeChange: boolean;
  eligible: boolean;
  reasonCode: string | null;
  reason: string | null;
  status: string;
  appliedBy: string | null;
  appliedAt: string | null;
  appliedPrice: string | null;
  errorMessage: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  PROPOSED: "atualizar",
  IN_SYNC: "em dia",
  INELIGIBLE: "não elegível",
  APPLYING: "aplicando",
  APPLIED: "aplicado e conferido",
  DIVERGED: "não refletido no ML",
  FAILED: "falhou",
  STALE: "não enviado (mudou)",
};
const STATUS_TONE: Record<string, string> = { PROPOSED: "info", IN_SYNC: "ok", INELIGIBLE: "warn", APPLIED: "ok", DIVERGED: "danger", FAILED: "danger", STALE: "warn", APPLYING: "info" };

const pct = (v: string | null) => (v === null ? "—" : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(1)}%`);

export function PricePanel(props: {
  run: { id: string; status: string; startedAt: string; requestedBy: string; priceTableCode: string } | null;
  proposals: Proposal[];
  applied: Proposal[];
  settings: { priceTableCode: string; branchId: string | null; maxChangePct: number };
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [agree, setAgree] = useState(false);
  const [agreeLarge, setAgreeLarge] = useState(false);
  const [filter, setFilter] = useState<"actionable" | "all" | "ineligible">("actionable");

  const actionable = props.proposals.filter((p) => p.status === "PROPOSED");
  const visible = filter === "all" ? props.proposals : filter === "ineligible" ? props.proposals.filter((p) => p.status === "INELIGIBLE") : actionable;
  const chosen = actionable.filter((p) => selected.has(p.id));
  const hasLarge = chosen.some((p) => p.largeChange);
  const counts = props.proposals.reduce<Record<string, number>>((a, p) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {});

  async function simulate() {
    setBusy("simulate");
    setConfirming(false);
    const r = await api<{ status: string; summary: { proposed: number; inSync: number; ineligible: number; largeChange: number; items: number } }>("/api/price-sync/preview", {
      method: "POST",
      body: {},
    });
    setBusy(null);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    const s = r.data.summary;
    setFeedback({
      kind: "success",
      text: `Simulação de preço ${r.data.status === "PARTIAL" ? "parcial (tempo esgotado; simule de novo para continuar) " : ""}concluída sem alterar o Mercado Livre: ${s.items} anúncio(s), ${s.proposed} com preço diferente da ADS (${s.largeChange} com variação grande), ${s.inSync} em dia, ${s.ineligible} não elegível(is).`,
    });
    setSelected(new Set());
    router.refresh();
  }

  async function apply() {
    setBusy("apply");
    const r = await api<{ results: { proposalId: string; itemId: string; status: string; message: string | null }[]; notProcessed: string[] }>("/api/price-sync/apply", {
      method: "POST",
      body: { proposalIds: chosen.map((p) => p.id), confirm: true, allowLargeChanges: agreeLarge },
    });
    setBusy(null);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    const c = r.data.results.reduce<Record<string, number>>((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {});
    const problems = r.data.results.filter((x) => x.status !== "APPLIED").map((x) => `${x.itemId}: ${x.message ?? STATUS_LABEL[x.status] ?? x.status}`);
    setFeedback({
      kind: problems.length ? "warn" : "success",
      text: `Resultado: ${Object.entries(c)
        .map(([k, n]) => `${n} ${STATUS_LABEL[k] ?? k.toLowerCase()}`)
        .join(", ")}${r.data.notProcessed.length ? `; ${r.data.notProcessed.length} não processada(s) por tempo — clique de novo para continuar` : ""}.${problems.length ? ` ${problems.slice(0, 5).join(" · ")}` : ""}`,
    });
    setConfirming(false);
    setAgree(false);
    setAgreeLarge(false);
    setSelected(new Set());
    router.refresh();
  }

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
    setConfirming(false);
  };

  return (
    <section aria-label="Sincronização de preço" style={{ marginBottom: 24 }}>
      <div className="toolbar" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Preço dos anúncios legados (ADS → Mercado Livre)</h2>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={simulate}>
          {busy === "simulate" ? "Consultando ADS e ML…" : "Simular preços (todos os legados vinculados)"}
        </button>
      </div>
      <p className="muted">
        Fonte: tabela <strong>{props.settings.priceTableCode}</strong> da ADS{props.settings.branchId ? `, filial ${props.settings.branchId}` : " (menor filial com preço ativo)"}. A
        simulação não altera nada. Só o preço é escrito, depois da sua confirmação; anúncios em promoção, kits e variações com preços diferentes ficam de fora. Variações acima de{" "}
        {props.settings.maxChangePct}% exigem confirmação adicional.
      </p>
      {feedback && <div className={`alert ${feedback.kind}`}>{feedback.text}</div>}
      {!props.run ? (
        <div className="card empty-state">Nenhuma simulação de preço ainda.</div>
      ) : (
        <>
          <p className="muted">
            Simulação de {formatDateTime(props.run.startedAt)} por {props.run.requestedBy} (tabela {props.run.priceTableCode}, {props.run.status}) · {counts.PROPOSED ?? 0} para
            atualizar, {counts.IN_SYNC ?? 0} em dia, {counts.INELIGIBLE ?? 0} não elegível(is).{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filtrar propostas de preço">
              <option value="actionable">Somente para atualizar</option>
              <option value="ineligible">Não elegíveis</option>
              <option value="all">Todos</option>
            </select>
          </p>
          {chosen.length > 0 && (
            <div className="bulkbar">
              <span>{chosen.length} anúncio(s) selecionado(s)</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => setConfirming(true)}>
                Revisar e atualizar preço
              </button>
            </div>
          )}
          {confirming && chosen.length > 0 && (
            <div className="confirm-box" style={{ marginBottom: 12 }}>
              <p>
                <strong>Resumo da operação</strong> (ADS, ML e promoções são reconsultados antes de cada escrita):
              </p>
              <ul>
                {chosen.map((p) => (
                  <li key={p.id}>
                    {p.marketplaceItemId} — {p.title ?? ""}: {formatMoney(p.marketplacePrice)} → <strong>{formatMoney(p.proposedPrice)}</strong> ({pct(p.changePct)})
                    {p.largeChange && <span className="chip warn"> variação grande</span>}
                  </li>
                ))}
              </ul>
              {hasLarge && (
                <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
                  <input type="checkbox" checked={agreeLarge} onChange={(e) => setAgreeLarge(e.target.checked)} />
                  Conferi os anúncios com variação acima de {props.settings.maxChangePct}% e quero aplicá-los também (sem isto, eles são ignorados).
                </label>
              )}
              <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                Confirmo a alteração do preço destes {chosen.length} anúncio(s) no Mercado Livre para o preço da tabela {props.settings.priceTableCode} da ADS. Quantidade, título, imagens e
                descrição não são alterados.
              </label>
              <div className="actions">
                <button type="button" className="btn btn-danger-solid btn-sm" disabled={!agree || !!busy} onClick={apply}>
                  {busy === "apply" ? "Atualizando…" : "Atualizar preço selecionado"}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos os anúncios para atualizar"
                      checked={actionable.length > 0 && actionable.every((p) => selected.has(p.id))}
                      onChange={(e) => {
                        setSelected(e.target.checked ? new Set(actionable.map((p) => p.id)) : new Set());
                        setConfirming(false);
                      }}
                    />
                  </th>
                  <th>Anúncio</th>
                  <th>Produto ADS</th>
                  <th className="num">Preço ML atual</th>
                  <th className="num">Preço ADS</th>
                  <th className="num">Variação</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {!visible.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Nada nesta lista.
                    </td>
                  </tr>
                )}
                {visible.map((p) => (
                  <tr key={p.id} className={selected.has(p.id) ? "selected" : undefined}>
                    <td>{p.status === "PROPOSED" && <input type="checkbox" aria-label={`Selecionar ${p.marketplaceItemId}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />}</td>
                    <td className="cell-name">
                      {p.marketplaceItemId}
                      <small>
                        {p.title ?? ""}
                        {p.variationIds.length ? ` · ${p.variationIds.length} variação(ões)` : ""}
                      </small>
                    </td>
                    <td>{p.adsProductIds.join(", ") || "—"}</td>
                    <td className="num">{p.marketplacePrice ? formatMoney(p.marketplacePrice) : "—"}</td>
                    <td className="num">
                      <strong>{p.adsPrice ? formatMoney(p.adsPrice) : "—"}</strong>
                    </td>
                    <td className="num">
                      {p.status === "PROPOSED" || p.status === "IN_SYNC" ? pct(p.changePct) : "—"}
                      {p.largeChange && p.status === "PROPOSED" && <small className="muted" style={{ display: "block" }}>grande</small>}
                    </td>
                    <td>
                      <span className={`chip ${STATUS_TONE[p.status] ?? ""}`} title={p.reasonCode ?? undefined}>
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                      {(p.reason || p.errorMessage) && <small className="muted" style={{ display: "block", maxWidth: 320 }}>{p.errorMessage ?? p.reason}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h3 style={{ marginTop: 20 }}>Últimas alterações de preço</h3>
      {!props.applied.length ? (
        <p className="muted">Nenhuma alteração de preço feita até agora.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Anúncio</th>
                <th className="num">Antes</th>
                <th className="num">Alvo</th>
                <th className="num">Conferido</th>
                <th>Resultado</th>
                <th>Autorizado por</th>
              </tr>
            </thead>
            <tbody>
              {props.applied.map((p) => (
                <tr key={p.id}>
                  <td>{formatDateTime(p.appliedAt)}</td>
                  <td className="cell-name">
                    {p.marketplaceItemId}
                    <small>{p.title ?? ""}</small>
                  </td>
                  <td className="num">{formatMoney(p.marketplacePrice)}</td>
                  <td className="num">{formatMoney(p.proposedPrice)}</td>
                  <td className="num">{p.appliedPrice ? formatMoney(p.appliedPrice) : "—"}</td>
                  <td>
                    <span className={`chip ${STATUS_TONE[p.status] ?? ""}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                    {p.errorMessage && <small className="muted" style={{ display: "block", maxWidth: 320 }}>{p.errorMessage}</small>}
                  </td>
                  <td>{p.appliedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
