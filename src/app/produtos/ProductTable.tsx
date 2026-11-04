"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { DRAFT_STATUS_LABEL, formatMoney, stockLabel } from "@/lib/format";

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
}

type Feedback = { kind: "success" | "error" | "warn"; text: string } | null;

const SKIP_REASON: Record<string, string> = {
  inactive: "inativo",
  already_exists: "já tinha rascunho",
  not_found: "não encontrado",
};

export function ProductTable({ rows, referenceTable }: { rows: ProductRowView[]; referenceTable: string | null }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const chosen = rows.filter((r) => selected.has(r.id));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  async function createDrafts() {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api<{ created: unknown[]; skipped: { reason: string }[] }>("/api/listing-drafts", { body: { productIds: chosen.map((c) => c.id) } });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      const skipped = r.data.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {});
      const skippedText = Object.entries(skipped)
        .map(([reason, n]) => `${n} ${SKIP_REASON[reason] ?? reason}`)
        .join(", ");
      setFeedback({
        kind: r.data.created.length ? "success" : "warn",
        text: `${r.data.created.length} rascunho(s) criado(s).${skippedText ? ` Ignorados: ${skippedText}.` : ""} Nenhum anúncio foi publicado.`,
      });
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function refreshSelected(kind: "prices" | "stocks") {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api(`/api/import/${kind}`, { body: { adsProductIds: chosen.map((c) => c.adsProductId) } });
      if (r.status === 409) return setFeedback({ kind: "warn", text: r.data.message ?? "Já existe uma atualização em andamento." });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setFeedback({ kind: "success", text: `Atualização de ${kind === "prices" ? "preços" : "estoque"} de ${chosen.length} produto(s) enviada para a fila.` });
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
      {selected.size > 0 && (
        <div className="bulkbar" role="region" aria-label="Ações em lote">
          <strong>{selected.size} selecionado(s)</strong>
          <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={createDrafts}>
            Criar rascunhos
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => refreshSelected("prices")}>
            Atualizar preços
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => refreshSelected("stocks")}>
            Atualizar estoque
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => setSelected(new Set())}>
            Limpar seleção
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>
                <input type="checkbox" aria-label="Selecionar todos desta página" checked={allSelected} onChange={toggleAll} />
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
                    <input type="checkbox" aria-label={`Selecionar ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
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
                      {draft && <span className={`chip ${draft.tone}`}>{draft.text}</span>}
                      {p.imageCount === 0 && <span className="chip">sem imagem</span>}
                    </div>
                  </td>
                  <td>
                    <a className="btn btn-secondary btn-sm" href={`/produtos/${p.id}`}>
                      Abrir
                    </a>
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
