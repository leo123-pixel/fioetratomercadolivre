"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { draftDisplayStatus, formatDateTime, formatMoney, listingStatusLabel, PUBLICATION_JOB_LABEL } from "@/lib/format";
import { useAutoListingSync } from "@/app/useAutoListingSync";

interface Row {
  id: number;
  productId: number;
  adsProductId: number;
  productName: string;
  title: string | null;
  familyName: string | null;
  status: string;
  version: number;
  marketplaceCategoryId: string | null;
  categoryName: string | null;
  listingPrice: string | null;
  listingQuantity: number | null;
  marketplaceItemId: string | null;
  permalink: string | null;
  listingStatus: string | null;
  primaryImageUrl: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface Job {
  id: string;
  listingDraftId: number;
  batchId: string | null;
  status: string;
  productName: string;
  adsProductId: number;
  errorMessage: string | null;
  marketplaceItemId: string | null;
  createdAt: string;
}

const LOCKED = ["VALIDATING", "PUBLISHING", "PUBLISHED", "UNKNOWN", "ARCHIVED"];

export function ListingsPanel(props: {
  tab: string;
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  account: { meliUserId: string | null; nickname: string | null; canWrite: boolean; connected: boolean };
}) {
  const router = useRouter();
  useAutoListingSync(props.account.connected && props.rows.some((r) => r.marketplaceItemId));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; validated: number; errors: number } | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);
  const [batch, setBatch] = useState<{ items: { draftId: number; draftVersion: number; fingerprint: string; name: string; price: string | null; quantity: number | null; category: string | null; publishable: boolean; reason: string | null }[] } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);

  const selectable = props.rows.filter((r) => !LOCKED.includes(r.status));
  const selRows = props.rows.filter((r) => selected.has(r.id));
  const validatedCount = selRows.filter((r) => r.status === "VALIDATED").length;

  const loadJobs = useCallback(async () => {
    const r = await api<{ items: Job[] }>("/api/marketplace/publication-jobs?limit=30");
    if (r.ok) setJobs(r.data.items);
  }, []);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  const activeJobs = jobs.filter((j) => j.status === "QUEUED" || j.status === "RUNNING" || j.status === "UNKNOWN");
  useEffect(() => {
    if (!activeJobs.some((j) => j.status !== "UNKNOWN")) return;
    const t = setInterval(async () => {
      await loadJobs();
      router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [activeJobs, loadJobs, router]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Relê no ML o status de todos os anúncios publicados (somente leitura). */
  async function syncStatuses() {
    setBusy("sync");
    setFeedback(null);
    try {
      const r = await api<{ checked: number; changed: number }>("/api/marketplace/listings/sync", { body: {} });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setFeedback({ kind: "success", text: `${r.data.checked} anúncio(s) consultado(s) no Mercado Livre; ${r.data.changed} com status alterado.` });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  /** Valida os selecionados um a um (cada validação consulta o Mercado Livre). */
  async function validateSelected() {
    const ids = selRows.filter((r) => !LOCKED.includes(r.status)).map((r) => r.id);
    setBusy("validate");
    setFeedback(null);
    let validated = 0;
    let errors = 0;
    setProgress({ done: 0, total: ids.length, validated, errors });
    for (const [i, id] of ids.entries()) {
      const r = await api<{ validation: { status: string } }>(`/api/listing-drafts/${id}/validate`, { body: {} });
      if (r.ok && r.data.validation.status === "VALIDATED") validated++;
      else errors++;
      setProgress({ done: i + 1, total: ids.length, validated, errors });
      if (r.status === 429) {
        setFeedback({ kind: "warn", text: "Limite de requisições atingido; aguarde e continue." });
        break;
      }
    }
    setBusy(null);
    router.refresh();
  }

  async function prepareBatch() {
    setBusy("review");
    setFeedback(null);
    setConfirmed(false);
    try {
      const items = [];
      for (const row of selRows.filter((r) => r.status === "VALIDATED")) {
        const r = await api<{ review: { draftVersion: number; price: string | null; quantity: number | null; categoryName: string | null; title: string | null }; fingerprint: string; publishable: boolean; reason: string | null }>(
          `/api/listing-drafts/${row.id}/review`,
        );
        if (!r.ok) continue;
        items.push({
          draftId: row.id,
          draftVersion: r.data.review.draftVersion,
          fingerprint: r.data.fingerprint,
          name: r.data.review.title ?? row.productName,
          price: r.data.review.price,
          quantity: r.data.review.quantity,
          category: r.data.review.categoryName,
          publishable: r.data.publishable,
          reason: r.data.reason,
        });
      }
      setBatch({ items });
    } finally {
      setBusy(null);
    }
  }

  async function publishBatch() {
    if (!batch) return;
    const items = batch.items.filter((i) => i.publishable).map(({ draftId, draftVersion, fingerprint }) => ({ draftId, draftVersion, fingerprint }));
    setBusy("publish");
    try {
      const r = await api<{ batchId: string; results: { draftId: number; ok: boolean; message?: string }[] }>("/api/listing-drafts/publish-batch", { body: { confirm: true, items } });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      const ok = r.data.results.filter((x) => x.ok).length;
      const fail = r.data.results.filter((x) => !x.ok);
      setFeedback({
        kind: fail.length ? "warn" : "success",
        text: `${ok} publicação(ões) enviada(s) para a fila (lote ${r.data.batchId.slice(0, 8)}).${fail.length ? ` ${fail.length} recusada(s): ${fail.map((f) => `#${f.draftId} ${f.message}`).join("; ")}` : ""} Os resultados aparecem individualmente.`,
      });
      setBatch(null);
      setSelected(new Set());
      await loadJobs();
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function cancelBatch(batchId: string) {
    const r = await api<{ canceled: number }>("/api/marketplace/publication-jobs", { body: { cancelBatch: batchId } });
    setFeedback(r.ok ? { kind: "success", text: `${r.data.canceled} publicação(ões) ainda na fila cancelada(s). As já enviadas não são canceladas.` } : { kind: "error", text: errorText(r) });
    await loadJobs();
    router.refresh();
  }

  const batches = [...new Set(activeJobs.filter((j) => j.batchId && j.status === "QUEUED").map((j) => j.batchId!))];
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));

  return (
    <>
      {!props.account.connected && <div className="alert error">Conta Mercado Livre não conectada. Conecte em Mercado Livre antes de validar ou publicar.</div>}
      {props.account.connected && !props.account.canWrite && <div className="alert error">A autorização da conta não inclui escrita (write): não é possível publicar.</div>}

      {activeJobs.length > 0 && (
        <section className="card" aria-live="polite">
          <h2>Fila de publicação</h2>
          {activeJobs.map((j) => {
            const s = PUBLICATION_JOB_LABEL[j.status] ?? { text: j.status, tone: "" };
            return (
              <div key={j.id} className="job-line">
                <div className="row">
                  <a href={`/anuncios/preparar/${j.listingDraftId}`}>
                    #{j.adsProductId} · {j.productName}
                  </a>
                  <span className={`chip ${s.tone}`}>{s.text}</span>
                </div>
                {j.errorMessage && <span className="hint warn">{j.errorMessage}</span>}
              </div>
            );
          })}
          {batches.map((b) => (
            <button key={b} className="btn btn-danger btn-sm" type="button" onClick={() => cancelBatch(b)} style={{ marginTop: 8, marginRight: 6 }}>
              Cancelar itens ainda na fila do lote {b.slice(0, 8)}
            </button>
          ))}
        </section>
      )}

      {props.account.connected && (
        <div className="toolbar">
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={syncStatuses}>
            {busy === "sync" ? "Consultando o Mercado Livre…" : "Atualizar status no Mercado Livre"}
          </button>
          <span className="muted">Lê no ML se cada anúncio publicado está ativo, pausado, encerrado ou excluído. Não altera nada no ML.</span>
        </div>
      )}

      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulkbar" role="region" aria-label="Ações em lote">
          <strong>{selected.size} selecionado(s)</strong>
          <span className="muted">
            · {validatedCount} validado(s) e prontos para publicar
            {progress ? ` · validação: ${progress.done}/${progress.total} (${progress.validated} ok, ${progress.errors} com pendências)` : ""}
          </span>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={validateSelected}>
            {busy === "validate" ? "Validando…" : "Validar selecionados"}
          </button>
          <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null || validatedCount === 0 || !props.account.canWrite} onClick={prepareBatch}>
            Publicar validados…
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setSelected(new Set())}>
            Limpar seleção
          </button>
        </div>
      )}

      {props.rows.length === 0 ? (
        <div className="card empty-state">Nenhum anúncio nesta situação. Prepare anúncios a partir da página Produtos.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos desta página"
                    checked={selectable.length > 0 && selectable.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th>Imagem</th>
                <th>Produto</th>
                <th className="num">ID ADS</th>
                <th>ID Mercado Livre</th>
                <th>Categoria</th>
                <th className="num">Preço</th>
                <th className="num">Qtd.</th>
                <th>Situação</th>
                <th>Atualizado</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => {
                const s = draftDisplayStatus(r.status, r.listingStatus);
                return (
                  <tr key={r.id} className={selected.has(r.id) ? "selected" : undefined}>
                    <td>
                      <input type="checkbox" aria-label={`Selecionar ${r.productName}`} disabled={LOCKED.includes(r.status)} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td>
                      {r.primaryImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="thumb" src={r.primaryImageUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="thumb empty">sem foto</span>
                      )}
                    </td>
                    <td className="cell-name">
                      <a href={`/anuncios/preparar/${r.id}`}>{r.familyName || r.title || r.productName}</a>
                      {r.lastError && r.status === "FAILED" && <small style={{ color: "var(--danger-fg)" }}>{r.lastError}</small>}
                    </td>
                    <td className="num">{r.adsProductId}</td>
                    <td>
                      {r.marketplaceItemId ? (
                        r.permalink ? (
                          <a href={r.permalink} target="_blank" rel="noopener noreferrer">
                            {r.marketplaceItemId}
                          </a>
                        ) : (
                          r.marketplaceItemId
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{r.categoryName ?? r.marketplaceCategoryId ?? "—"}</td>
                    <td className="num">{formatMoney(r.listingPrice)}</td>
                    <td className="num">{r.listingQuantity ?? "—"}</td>
                    <td>
                      <span className={`chip ${s.tone}`}>{s.text}</span>
                      {r.listingStatus && r.status !== "PUBLISHED" && (
                        <span className={`chip ${listingStatusLabel(r.listingStatus).tone}`} style={{ marginLeft: 4 }}>
                          anterior: {listingStatusLabel(r.listingStatus).text}
                        </span>
                      )}
                    </td>
                    <td>{formatDateTime(r.updatedAt)}</td>
                    <td>
                      <a className="btn btn-secondary btn-sm" href={`/anuncios/preparar/${r.id}`}>
                        {r.status === "PUBLISHED" ? "Detalhes" : "Editar"}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav className="pagination" aria-label="Paginação">
        <span className="muted">
          {props.total} anúncio(s) · página {props.page} de {pages}
        </span>
        <div className="pages">
          {props.page > 1 && (
            <a className="btn btn-secondary btn-sm" href={`/anuncios?tab=${props.tab}&page=${props.page - 1}`}>
              ← Anterior
            </a>
          )}
          {props.page < pages && (
            <a className="btn btn-secondary btn-sm" href={`/anuncios?tab=${props.tab}&page=${props.page + 1}`}>
              Próxima →
            </a>
          )}
        </div>
      </nav>

      {batch && (
        <div role="dialog" aria-modal="true" aria-labelledby="batch-title" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}>
          <div className="card" style={{ maxWidth: 760, width: "100%", maxHeight: "90vh", overflow: "auto", marginBottom: 0 }}>
            <h2 id="batch-title">Confirmar publicação em lote</h2>
            <p>
              Conta de destino: <strong>{props.account.nickname ?? "—"}</strong> ({props.account.meliUserId}). Selecionados: {selected.size} · prontos:{" "}
              {batch.items.filter((i) => i.publishable).length} · com pendência: {batch.items.filter((i) => !i.publishable).length + (selected.size - batch.items.length)}.
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th>Categoria</th>
                    <th className="num">Preço</th>
                    <th className="num">Qtd.</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.items.map((i) => (
                    <tr key={i.draftId}>
                      <td>{i.name}</td>
                      <td>{i.category ?? "—"}</td>
                      <td className="num">{formatMoney(i.price)}</td>
                      <td className="num">{i.quantity ?? "—"}</td>
                      <td>{i.publishable ? <span className="chip ok">pronto</span> : <span className="chip danger">{i.reason}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">Os anúncios entram em uma fila persistente e são enviados um a um, respeitando os limites da API. Uma falha não interrompe os demais.</p>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontWeight: 500 }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 4 }} />
              Confirmo a criação de {batch.items.filter((i) => i.publishable).length} anúncio(s) na conta {props.account.nickname ?? props.account.meliUserId}.
            </label>
            <div className="actions">
              <button className="btn btn-primary" type="button" disabled={!confirmed || busy !== null || !batch.items.some((i) => i.publishable)} onClick={publishBatch}>
                {busy === "publish" ? "Enviando…" : "Publicar no Mercado Livre"}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setBatch(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
