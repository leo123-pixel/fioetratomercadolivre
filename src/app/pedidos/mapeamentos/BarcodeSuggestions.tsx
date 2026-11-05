"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/client-api";

interface Suggestion {
  itemId: string;
  variationId: string;
  title: string | null;
  orders: number;
  gtins: string[];
  candidates: { productId: number; adsProductId: number; name: string; ean: string | null }[];
}

const keyOf = (s: Suggestion) => `${s.itemId}:${s.variationId}`;

/** Sugestões por código de barras (GTIN do anúncio = EAN do produto ADS), confirmadas em lote pelo administrador. */
export function BarcodeSuggestions({ onDone }: { onDone: (msg: string) => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [choice, setChoice] = useState<Record<string, number | "">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy("load");
    setError(null);
    const r = await api<{ items: Suggestion[] }>("/api/mappings/suggestions");
    setBusy(null);
    if (!r.ok) return setError(errorText(r));
    setItems(r.data.items);
    // Pré-seleciona só quando há exatamente UM produto ADS com o mesmo código de barras.
    setChoice(Object.fromEntries(r.data.items.map((s) => [keyOf(s), s.candidates.length === 1 ? s.candidates[0].productId : ""])));
  }

  async function confirm() {
    const selected = (items ?? []).filter((s) => choice[keyOf(s)]);
    if (!selected.length) return;
    if (!window.confirm(`Confirmar ${selected.length} vínculo(s) por código de barras? Cada anúncio passa a usar o produto ADS escolhido em todas as vendas.`)) return;
    setBusy("save");
    const r = await api<{ results: { ok: boolean }[]; remapped: { mapped: number; orders: number } }>("/api/mappings/bulk", {
      body: { note: "sugestão por código de barras", items: selected.map((s) => ({ itemId: s.itemId, variationId: s.variationId || null, productId: choice[keyOf(s)] })) },
    });
    setBusy(null);
    if (!r.ok) return setError(errorText(r));
    const ok = r.data.results.filter((x) => x.ok).length;
    onDone(`${ok} vínculo(s) salvo(s) por código de barras; ${r.data.remapped.mapped} linha(s) de ${r.data.remapped.orders} pedido(s) mapeada(s).`);
    setItems(null);
  }

  const withMatch = (items ?? []).filter((s) => s.candidates.length > 0);
  const selectedCount = (items ?? []).filter((s) => choice[keyOf(s)]).length;
  return (
    <section className="card">
      <h2>Atalho: sugestões por código de barras</h2>
      <p className="muted">
        Lê o código de barras (GTIN) cadastrado em cada anúncio no Mercado Livre e procura o produto da ADS com o mesmo EAN. É só uma sugestão: confira e
        confirme.
      </p>
      <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null} onClick={load}>
        {busy === "load" ? "Consultando anúncios no Mercado Livre…" : items ? "Buscar de novo" : "Buscar sugestões por código de barras"}
      </button>
      {error && <div className="alert error">{error}</div>}
      {items && (
        <>
          <p>
            {withMatch.length} de {items.length} anúncio(s) com produto ADS de mesmo código de barras.
            {items.length - withMatch.length > 0 && ` ${items.length - withMatch.length} sem GTIN no anúncio ou sem EAN igual na ADS: mapeie manualmente abaixo.`}
          </p>
          {withMatch.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Anúncio ML</th>
                    <th>GTIN</th>
                    <th>Produto ADS sugerido</th>
                  </tr>
                </thead>
                <tbody>
                  {withMatch.map((s) => (
                    <tr key={keyOf(s)}>
                      <td>
                        {s.itemId}
                        <small className="muted" style={{ display: "block" }}>
                          {s.title} · {s.orders} venda(s)
                        </small>
                      </td>
                      <td>{s.gtins.join(", ")}</td>
                      <td>
                        <select value={choice[keyOf(s)] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [keyOf(s)]: e.target.value ? Number(e.target.value) : "" }))}>
                          <option value="">— não vincular —</option>
                          {s.candidates.map((c) => (
                            <option key={c.productId} value={c.productId}>
                              #{c.adsProductId} · {c.name} (EAN {c.ean ?? "—"})
                            </option>
                          ))}
                        </select>
                        {s.candidates.length > 1 && <small style={{ display: "block", color: "var(--warn-fg)" }}>Mais de um produto ADS com esse código: escolha.</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button className="btn btn-primary btn-sm" type="button" style={{ marginTop: 8 }} disabled={busy !== null || !selectedCount} onClick={confirm}>
            {busy === "save" ? "Salvando…" : `Confirmar ${selectedCount} vínculo(s)`}
          </button>
        </>
      )}
    </section>
  );
}
