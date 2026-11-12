"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatMoney } from "@/lib/format";

interface StockProposal {
  id: string;
  marketplaceItemIds: string[];
  eligible: boolean;
  status: string;
  reason: string | null;
  marketplaceQuantity: number | null;
  proposedQuantity: number | null;
  direction: "INCREASE" | "DECREASE" | "NONE" | null;
}

interface PriceProposal {
  id: string;
  marketplaceItemId: string;
  status: string;
  reason: string | null;
  marketplacePrice: string | null;
  proposedPrice: string | null;
  changePct: string | null;
  largeChange: boolean;
}

interface Review {
  stock: { proposal: StockProposal | null; token: string | null; blockers: string[]; error: string | null };
  price: { proposal: PriceProposal | null; error: string | null } | null;
}

const pct = (v: string | null) => (v === null ? "" : ` (${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(1)}%)`);

/**
 * Aprovação direto na linha: reconsulta ADS e ML só deste anúncio (estoque e, se legado, preço), mostra o que
 * muda e aplica somente o que o operador confirmar.
 */
export function ApproveRow(props: { itemId: string; legacy: boolean; onClose: () => void; onDone: (msg: string, kind: "success" | "warn" | "error") => void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [useStock, setUseStock] = useState(true);
  const [usePrice, setUsePrice] = useState(true);
  const [agreeLarge, setAgreeLarge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: "success" | "warn"; text: string } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const stockReq = api<{ proposals: StockProposal[] }>("/api/stock-sync/preview", { method: "POST", body: { itemIds: [props.itemId] } });
    const priceReq = props.legacy ? api<{ proposals: PriceProposal[] }>("/api/price-sync/preview", { method: "POST", body: { itemIds: [props.itemId] } }) : null;
    const [s, p] = await Promise.all([stockReq, priceReq]);

    const stock: Review["stock"] = { proposal: null, token: null, blockers: [], error: null };
    if (!s.ok) stock.error = errorText(s);
    else {
      stock.proposal = s.data.proposals.find((x) => x.marketplaceItemIds.includes(props.itemId)) ?? null;
      if (stock.proposal?.status === "PROPOSED") {
        const v = await api<{ blockers: string[]; confirmationToken: string | null; items: { ok: boolean; reason: string | null }[] }>("/api/stock-sync/validate", {
          method: "POST",
          body: { proposalIds: [stock.proposal.id] },
        });
        if (!v.ok) stock.error = errorText(v);
        else {
          stock.token = v.data.confirmationToken;
          stock.blockers = [...v.data.blockers, ...v.data.items.filter((i) => !i.ok && i.reason).map((i) => i.reason!)];
        }
      }
    }
    let price: Review["price"] = null;
    if (p) price = p.ok ? { proposal: p.data.proposals.find((x) => x.marketplaceItemId === props.itemId) ?? null, error: null } : { proposal: null, error: errorText(p) };

    setReview({ stock, price });
    setUseStock(!!stock.token);
    setUsePrice(price?.proposal?.status === "PROPOSED");
    setLoading(false);
  }

  const stockReady = !!review?.stock.token && review.stock.proposal?.status === "PROPOSED";
  const priceReady = review?.price?.proposal?.status === "PROPOSED";
  const priceLarge = !!review?.price?.proposal?.largeChange;
  const canApply = (useStock && stockReady) || (usePrice && priceReady && (!priceLarge || agreeLarge));

  async function apply() {
    if (!review) return;
    setApplying(true);
    const parts: string[] = [];
    let bad = false;
    if (useStock && stockReady) {
      const r = await api<{ jobs: { status: string; errorMessage: string | null }[]; skipped: { reason: string }[] }>("/api/stock-sync/apply", {
        method: "POST",
        body: { proposalIds: [review.stock.proposal!.id], confirmationToken: review.stock.token, confirm: true },
      });
      if (!r.ok) {
        bad = true;
        parts.push(`Estoque: ${errorText(r)}`);
      } else {
        const job = r.data.jobs[0];
        if (job?.status === "SUCCEEDED") parts.push(`Estoque atualizado para ${review.stock.proposal!.proposedQuantity} e conferido no ML`);
        else {
          bad = true;
          parts.push(`Estoque: ${job?.errorMessage ?? r.data.skipped[0]?.reason ?? job?.status ?? "não aplicado"}`);
        }
      }
    }
    if (usePrice && priceReady && (!priceLarge || agreeLarge)) {
      const r = await api<{ results: { status: string; message: string | null }[] }>("/api/price-sync/apply", {
        method: "POST",
        body: { proposalIds: [review.price!.proposal!.id], confirm: true, allowLargeChanges: agreeLarge },
      });
      if (!r.ok) {
        bad = true;
        parts.push(`Preço: ${errorText(r)}`);
      } else {
        const res = r.data.results[0];
        if (res?.status === "APPLIED") parts.push(`Preço atualizado para ${formatMoney(review.price!.proposal!.proposedPrice)} e conferido no ML`);
        else {
          bad = true;
          parts.push(`Preço: ${res?.message ?? res?.status ?? "não aplicado"}`);
        }
      }
    }
    setApplying(false);
    const text = `${props.itemId}: ${parts.join(" · ")}.`;
    setResult({ kind: bad ? "warn" : "success", text });
    props.onDone(text, bad ? "warn" : "success");
  }

  if (result) {
    return (
      <div className="confirm-box">
        <div className={`alert ${result.kind}`}>{result.text}</div>
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={props.onClose}>
            Fechar
          </button>
        </div>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="confirm-box">
        <p>
          <strong>Aprovar atualização de {props.itemId}</strong>
        </p>
        <p className="muted">
          Primeiro o sistema consulta agora a ADS e o Mercado Livre deste anúncio (nada é alterado) e mostra o que muda{props.legacy ? " no estoque e no preço" : " no estoque"}.
        </p>
        {error && <div className="alert error">{error}</div>}
        <div className="actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={loading} onClick={load}>
            {loading ? "Consultando ADS e ML…" : "Consultar e revisar"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={props.onClose}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  const sp = review.stock.proposal;
  const pp = review.price?.proposal ?? null;
  return (
    <div className="confirm-box">
      <p>
        <strong>Aprovar atualização de {props.itemId}</strong> (ADS e ML consultados agora)
      </p>
      <ul style={{ listStyle: "none", paddingLeft: 0 }}>
        <li style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", gap: 8, fontWeight: 400, alignItems: "baseline" }}>
            <input type="checkbox" checked={useStock && stockReady} disabled={!stockReady} onChange={(e) => setUseStock(e.target.checked)} />
            <span>
              <strong>Estoque:</strong>{" "}
              {review.stock.error ? (
                <span className="chip danger">{review.stock.error}</span>
              ) : !sp ? (
                <span className="muted">sem proposta para este anúncio</span>
              ) : sp.status === "PROPOSED" ? (
                <>
                  {sp.marketplaceQuantity ?? "?"} → <strong>{sp.proposedQuantity}</strong> unidade(s) no ML
                </>
              ) : sp.eligible && sp.direction === "NONE" ? (
                <span className="chip ok">já está igual à ADS ({sp.marketplaceQuantity})</span>
              ) : (
                <span className="chip warn">não elegível</span>
              )}
              {sp?.reason && sp.status !== "PROPOSED" && <small className="muted" style={{ display: "block" }}>{sp.reason}</small>}
              {review.stock.blockers.map((b) => (
                <small key={b} className="muted" style={{ display: "block", color: "var(--danger-fg)" }}>
                  {b}
                </small>
              ))}
            </span>
          </label>
        </li>
        {review.price && (
          <li>
            <label style={{ display: "flex", gap: 8, fontWeight: 400, alignItems: "baseline" }}>
              <input type="checkbox" checked={usePrice && priceReady} disabled={!priceReady} onChange={(e) => setUsePrice(e.target.checked)} />
              <span>
                <strong>Preço:</strong>{" "}
                {review.price.error ? (
                  <span className="chip danger">{review.price.error}</span>
                ) : !pp ? (
                  <span className="muted">sem proposta para este anúncio</span>
                ) : pp.status === "PROPOSED" ? (
                  <>
                    {formatMoney(pp.marketplacePrice)} → <strong>{formatMoney(pp.proposedPrice)}</strong>
                    {pct(pp.changePct)} (tabela da ADS)
                  </>
                ) : pp.status === "IN_SYNC" ? (
                  <span className="chip ok">já está igual à ADS ({formatMoney(pp.marketplacePrice)})</span>
                ) : (
                  <span className="chip warn">não elegível</span>
                )}
                {pp?.reason && pp.status !== "PROPOSED" && <small className="muted" style={{ display: "block" }}>{pp.reason}</small>}
              </span>
            </label>
            {priceReady && priceLarge && (
              <label style={{ display: "flex", gap: 8, fontWeight: 400, marginLeft: 24 }}>
                <input type="checkbox" checked={agreeLarge} onChange={(e) => setAgreeLarge(e.target.checked)} />
                Variação de preço grande{pct(pp!.changePct)}: conferi e quero aplicar.
              </label>
            )}
          </li>
        )}
      </ul>
      <div className="actions">
        <button type="button" className="btn btn-danger-solid btn-sm" disabled={!canApply || applying} onClick={apply}>
          {applying ? "Aplicando no Mercado Livre…" : "Aprovar e aplicar no Mercado Livre"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={applying} onClick={props.onClose}>
          Cancelar
        </button>
      </div>
      {!stockReady && !priceReady && <p className="hint">Nada para aprovar neste anúncio agora.</p>}
    </div>
  );
}
