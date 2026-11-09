"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { DRAFT_STATUS_LABEL, formatMoney, listingStatusLabel, stockLabel } from "@/lib/format";
import { useAutoListingSync } from "@/app/(admin)/useAutoListingSync";

export interface ProductRowView {
  id: number;
  adsProductId: number;
  name: string;
  nameOriginal: string;
  hasCustomName: boolean;
  ean: string | null;
  manufacturerCode: string | null;
  supplierId: number | null;
  supplierName: string | null;
  inactive: boolean;
  primaryImageUrl: string | null;
  imageCount: number;
  referencePrice: string | null;
  referenceBranch: string | null;
  stockTotal: string | null;
  stockBranches: number;
  stockFetchedAt: string | null;
  draftId: number | null;
  draftStatus: string | null;
  marketplaceItemId: string | null;
  permalink: string | null;
  listingStatus: string | null;
}

type Feedback = { kind: "success" | "error" | "warn"; text: string } | null;

const SKIP_REASON: Record<string, string> = {
  inactive: "inativo",
  already_exists: "já tinha rascunho",
  already_published: "já publicado",
  not_found: "não encontrado",
};

/** Seleção guardada na sessão do navegador: sobrevive à paginação e a filtros, até ser limpa. */
const STORAGE_KEY = "ft:produtos:selecao";

function loadSelection(): Map<number, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return new Map(raw ? (JSON.parse(raw) as [number, number][]) : []);
  } catch {
    return new Map();
  }
}

function saveSelection(sel: Map<number, number>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...sel.entries()]));
  } catch {
    // armazenamento indisponível: seleção vale só nesta página
  }
}

export function ProductTable({
  rows,
  referenceTable,
  total,
  filter,
}: {
  rows: ProductRowView[];
  referenceTable: string | null;
  total: number;
  filter: Record<string, string>;
}) {
  const router = useRouter();
  useAutoListingSync(rows.some((r) => r.marketplaceItemId));
  /** id local → id ADS */
  const [selected, setSelected] = useState<Map<number, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => setSelected(loadSelection()), []);
  function update(next: Map<number, number>) {
    setSelected(next);
    saveSelection(next);
  }

  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggle(r: ProductRowView) {
    const next = new Map(selected);
    if (next.has(r.id)) next.delete(r.id);
    else next.set(r.id, r.adsProductId);
    update(next);
  }

  function togglePage() {
    const next = new Map(selected);
    for (const r of rows) {
      if (pageAllSelected) next.delete(r.id);
      else next.set(r.id, r.adsProductId);
    }
    update(next);
  }

  function summarize(r: { created: unknown[]; skipped: { reason: string }[] }) {
    const skipped = r.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {});
    const text = Object.entries(skipped)
      .map(([reason, n]) => `${n} ${SKIP_REASON[reason] ?? reason}`)
      .join(", ");
    return `${r.created.length} rascunho(s) criado(s).${text ? ` Ignorados: ${text}.` : ""} Nada foi publicado.`;
  }

  async function prepare(body: Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api<{ created: { draftId: number }[]; skipped: { reason: string; draftId?: number }[] }>("/api/listing-drafts", { body });
      if (!r.ok) return setFeedback({ kind: r.status === 409 ? "warn" : "error", text: errorText(r) });
      update(new Map());
      setConfirmAll(false);
      const createdOrExisting = [...r.data.created.map((c) => c.draftId), ...r.data.skipped.filter((s) => s.reason === "already_exists").map((s) => s.draftId!)];
      if (createdOrExisting.length === 1) return router.push(`/anuncios/preparar/${createdOrExisting[0]}`);
      setFeedback({ kind: r.data.created.length ? "success" : "warn", text: summarize(r.data) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function refreshSelected(kind: "prices" | "stocks") {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api(`/api/import/${kind}`, { body: { adsProductIds: [...selected.values()] } });
      if (r.status === 409) return setFeedback({ kind: "warn", text: r.data.message ?? "Já existe uma atualização em andamento." });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setFeedback({ kind: "success", text: `Atualização de ${kind === "prices" ? "preços" : "estoque"} de ${selected.size} produto(s) enviada para a fila.` });
      window.dispatchEvent(new Event("import-jobs-changed"));
    } finally {
      setBusy(false);
    }
  }

  if (!rows.length) return <div className="card empty-state">Nenhum produto corresponde aos filtros.</div>;

  return (
    <>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}
      {(selected.size > 0 || pageAllSelected) && (
        <div className="bulkbar" role="region" aria-label="Ações em lote">
          <strong>{selected.size} selecionado(s)</strong>
          <button className="btn btn-primary btn-sm" type="button" disabled={busy || !selected.size} onClick={() => prepare({ productIds: [...selected.keys()] })}>
            Preparar anúncios
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy || !selected.size} onClick={() => refreshSelected("prices")}>
            Atualizar preços
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy || !selected.size} onClick={() => refreshSelected("stocks")}>
            Atualizar estoque
          </button>
          {pageAllSelected && total > rows.length && !confirmAll && (
            <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => setConfirmAll(true)}>
              Selecionar todos os {total} resultados do filtro…
            </button>
          )}
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => update(new Map())}>
            Limpar seleção
          </button>
        </div>
      )}
      {confirmAll && (
        <div className="confirm-box" role="alertdialog" aria-label="Confirmar seleção do filtro">
          <p>
            Preparar rascunhos para <strong>todos os {total} produtos</strong> do filtro atual? Produtos inativos e os que já têm rascunho ou anúncio
            serão ignorados. Nada será publicado.
          </p>
          <div className="actions">
            <button className="btn btn-primary" type="button" disabled={busy || total > 1000} onClick={() => prepare({ filter, confirmAll: true, expectedCount: total })}>
              {total > 1000 ? "Máximo de 1000 por vez — refine o filtro" : `Confirmar ${total} produtos`}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setConfirmAll(false)}>
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
                <input type="checkbox" aria-label="Selecionar todos desta página" checked={pageAllSelected} onChange={togglePage} />
              </th>
              <th>Imagem</th>
              <th>Produto</th>
              <th className="num">ID ADS</th>
              <th>EAN</th>
              <th>Cód. fabricante</th>
              <th>Fornecedor</th>
              <th>Tabela</th>
              <th className="num">Preço ref.</th>
              <th className="num">Estoque</th>
              <th>Situação</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const stock = stockLabel(p.stockTotal, p.stockBranches);
              const draft = p.draftStatus ? DRAFT_STATUS_LABEL[p.draftStatus] : null;
              return (
                <tr key={p.id} className={selected.has(p.id) ? "selected" : undefined}>
                  <td>
                    <input type="checkbox" aria-label={`Selecionar ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p)} />
                  </td>
                  <td>
                    {p.primaryImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="thumb" src={p.primaryImageUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="thumb empty">sem foto</span>
                    )}
                  </td>
                  <td className="cell-name">
                    <a href={`/produtos/${p.id}`}>{p.name || "(sem descrição na ADS)"}</a>
                    {p.hasCustomName && <small>ADS: {p.nameOriginal}</small>}
                  </td>
                  <td className="num">{p.adsProductId}</td>
                  <td>{p.ean ?? "—"}</td>
                  <td>{p.manufacturerCode ?? "—"}</td>
                  <td>{p.supplierName ?? (p.supplierId !== null ? `#${p.supplierId}` : "—")}</td>
                  <td>{referenceTable ? `${referenceTable}${p.referenceBranch ? ` · ${p.referenceBranch}` : ""}` : "—"}</td>
                  <td className="num">{p.referencePrice ? formatMoney(p.referencePrice) : <span className="muted">indisponível</span>}</td>
                  <td className="num">
                    <span className={stock.tone ? `chip ${stock.tone}` : "chip"}>{stock.text}</span>
                  </td>
                  <td>
                    <div className="toolbar">
                      {p.inactive ? <span className="chip danger">Inativo</span> : <span className="chip ok">Ativo</span>}
                      {p.marketplaceItemId ? (
                        p.permalink ? (
                          <a className={`chip ${listingStatusLabel(p.listingStatus).tone}`} href={p.permalink} target="_blank" rel="noopener noreferrer">
                            {listingStatusLabel(p.listingStatus).text} · {p.marketplaceItemId}
                          </a>
                        ) : (
                          <span className={`chip ${listingStatusLabel(p.listingStatus).tone}`}>
                            {listingStatusLabel(p.listingStatus).text} · {p.marketplaceItemId}
                          </span>
                        )
                      ) : (
                        draft && <span className={`chip ${draft.tone}`}>{draft.text}</span>
                      )}
                      {p.imageCount === 0 && <span className="chip">sem imagem</span>}
                    </div>
                  </td>
                  <td>
                    <div className="toolbar">
                      <a className="btn btn-secondary btn-sm" href={`/produtos/${p.id}`}>
                        Abrir
                      </a>
                      {p.draftId && (
                        <a className="btn btn-secondary btn-sm" href={`/anuncios/preparar/${p.draftId}`}>
                          Anúncio
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
