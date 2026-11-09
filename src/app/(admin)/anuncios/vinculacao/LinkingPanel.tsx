"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { ProductPicker, type PickedProduct } from "@/app/(admin)/pedidos/ProductPicker";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime, formatNumber, listingStatusLabel } from "@/lib/format";

export interface Row {
  id: string;
  marketplaceItemId: string;
  variationId: string;
  variationLabel: string | null;
  userProductId: string | null;
  title: string | null;
  status: string | null;
  subStatus: string[];
  sellerSku: string | null;
  gtins: string[];
  availableQuantity: number | null;
  logisticType: string | null;
  thumbnail: string | null;
  permalink: string | null;
  origin: "INTEGRATOR" | "EXTERNAL";
  poolKey: string;
  linkStatus: "LINKED" | "CONFIRMED" | "PENDING" | "AMBIGUOUS" | "UNLINKED";
  linkProductId: number | null;
  linkProductName: string | null;
  linkAdsProductId: number | null;
  mappingSource: string | null;
  mappingBy: string | null;
  mappingAt: string | null;
  mappingMaxQuantity: number | null;
  componentCount: number;
  suggestedProductId: number | null;
  suggestedProductName: string | null;
  suggestedAdsProductId: number | null;
  suggestionSource: string | null;
  suggestionConfidence: string | null;
  candidateCount: number;
  adsTotal: string | null;
  adsBranches: number | null;
  adsFetchedAt: string | null;
  manageable: boolean;
  productPools: number;
  lastProposalStatus: string | null;
  lastJobStatus: string | null;
}

type Tone = "ok" | "warn" | "danger" | "info" | "";
export const LINK_LABEL: Record<Row["linkStatus"], { text: string; tone: Tone }> = {
  LINKED: { text: "Vinculado (publicação)", tone: "ok" },
  CONFIRMED: { text: "Vínculo confirmado", tone: "ok" },
  PENDING: { text: "Sugestão pendente", tone: "info" },
  AMBIGUOUS: { text: "Ambíguo", tone: "warn" },
  UNLINKED: { text: "Sem vínculo", tone: "danger" },
};
export const SOURCE_LABEL: Record<string, string> = {
  EXISTING_LINK: "publicação",
  SKU_MATCH: "SKU",
  GTIN_MATCH: "GTIN",
  MANUFACTURER_MATCH: "cód. fabricante",
  MANUAL: "manual",
};
export const CONFIDENCE_LABEL: Record<string, { text: string; tone: Tone }> = {
  HIGH: { text: "confiança alta", tone: "ok" },
  MEDIUM: { text: "confiança média", tone: "warn" },
  LOW: { text: "confiança baixa", tone: "danger" },
};

interface Candidate {
  productId: number;
  adsProductId: number;
  name: string;
  ean: string | null;
  manufacturerCode: string | null;
  brand: string | null;
  kit: boolean;
  source: string;
  confidence: string;
  evidence: { source: string; confidence: string; detail: string }[];
}

interface Policy {
  safetyReserve: number | null;
  allocationMode: "EXCLUSIVE" | "SPLIT_EVEN";
  autoSyncApproved: boolean;
  approvedBy: string | null;
}

const isLinked = (r: Row) => r.linkStatus === "LINKED" || r.linkStatus === "CONFIRMED";
const batchable = (r: Row) => r.linkStatus === "PENDING" && r.suggestionConfidence === "HIGH" && (r.suggestionSource === "SKU_MATCH" || r.suggestionSource === "GTIN_MATCH");

function Detail({ row, onDone }: { row: Row; onDone: (msg: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ candidates: Candidate[]; titleHints: { productId: number; adsProductId: number; name: string }[]; ambiguous: boolean } | null>(null);
  const [picked, setPicked] = useState<{ productId: number; adsProductId: number; name: string; kit?: boolean } | null>(null);
  const [components, setComponents] = useState<{ productId: number; adsProductId: number; name: string; quantity: number }[]>([]);
  const [maxQuantity, setMaxQuantity] = useState<string>(row.mappingMaxQuantity === null ? "" : String(row.mappingMaxQuantity));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await api<{ candidates: Candidate[]; titleHints: { productId: number; adsProductId: number; name: string }[]; ambiguous: boolean }>(`/api/legacy-listings/${row.id}/candidates`);
    setLoading(false);
    if (r.ok) setData(r.data);
    else setError(errorText(r));
    if (row.linkProductId) {
      const g = await api<{ policy: Policy | null }>(`/api/stock-sync/groups/${row.linkProductId}`);
      if (g.ok) setPolicy(g.data.policy ?? { safetyReserve: null, allocationMode: "EXCLUSIVE", autoSyncApproved: false, approvedBy: null });
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  async function confirm() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/legacy-listings/${row.id}/map`, {
      method: "POST",
      body: {
        productId: picked.productId,
        components: components.length ? components.map((c) => ({ productId: c.productId, quantity: c.quantity })) : undefined,
        maxQuantity: maxQuantity.trim() === "" ? null : Number(maxQuantity),
        replace: row.linkStatus === "CONFIRMED",
        confirm: true,
      },
    });
    setBusy(false);
    if (r.ok) onDone(`Vínculo confirmado: ${row.marketplaceItemId} → ADS #${picked.adsProductId}`);
    else setError(errorText(r));
  }

  async function reject(productId: number) {
    setBusy(true);
    const r = await api(`/api/legacy-listings/${row.id}/reject`, { method: "POST", body: { productId } });
    setBusy(false);
    if (r.ok) onDone("Sugestão recusada");
    else setError(errorText(r));
  }

  async function remove() {
    setBusy(true);
    const r = await api(`/api/legacy-listings/${row.id}/map`, { method: "DELETE", body: { confirm: true } });
    setBusy(false);
    if (r.ok) onDone("Vínculo removido");
    else setError(errorText(r));
  }

  async function savePolicy(patch: Partial<Policy>) {
    if (!row.linkProductId) return;
    setBusy(true);
    const r = await api<{ policy: Policy }>(`/api/stock-sync/groups/${row.linkProductId}`, { method: "PATCH", body: patch });
    setBusy(false);
    if (r.ok) setPolicy(r.data.policy);
    else setError(errorText(r));
  }

  const choose = (p: { productId: number; adsProductId: number; name: string; kit?: boolean }) => {
    setPicked(p);
    setComponents([]);
  };

  return (
    <div style={{ display: "grid", gap: 12, padding: "8px 0" }}>
      {error && <div className="alert error">{error}</div>}
      {loading && <span className="muted">Carregando candidatos…</span>}
      {data && (
        <div>
          <strong>Candidatos</strong>
          {data.ambiguous && <span className="chip warn" style={{ marginLeft: 8 }}>ambíguo: escolha manual</span>}
          {!data.candidates.length && <p className="muted">Nenhum candidato por SKU, GTIN ou código do fabricante.</p>}
          <ul style={{ listStyle: "none", padding: 0, margin: "6px 0", display: "grid", gap: 6 }}>
            {data.candidates.map((c) => (
              <li key={c.productId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button type="button" className={`btn btn-sm ${picked?.productId === c.productId ? "btn-primary" : "btn-secondary"}`} onClick={() => choose({ ...c })}>
                  #{c.adsProductId} · {c.name}
                </button>
                <span className={`chip ${CONFIDENCE_LABEL[c.confidence]?.tone ?? ""}`}>{CONFIDENCE_LABEL[c.confidence]?.text ?? c.confidence}</span>
                {c.kit && <span className="chip warn">kit: informe a composição</span>}
                <small className="muted">{c.evidence.map((e) => e.detail).join(" · ")}</small>
                {row.linkStatus !== "LINKED" && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => reject(c.productId)}>
                    Rejeitar sugestão
                  </button>
                )}
              </li>
            ))}
          </ul>
          {data.titleHints.length > 0 && (
            <details>
              <summary className="muted">Parecidos pelo título (apenas referência visual)</summary>
              <ul style={{ margin: "6px 0" }}>
                {data.titleHints.map((h) => (
                  <li key={h.productId}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => choose(h)}>
                      #{h.adsProductId} · {h.name}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {row.linkStatus !== "LINKED" && (
        <>
          <div>
            <strong>Buscar produto ADS</strong>
            <ProductPicker onPick={(p: PickedProduct) => choose({ productId: p.id, adsProductId: p.adsProductId, name: p.name })} />
          </div>
          {picked && (
            <div className="card" style={{ margin: 0 }}>
              <p style={{ marginTop: 0 }}>
                Vincular <strong>{row.marketplaceItemId}</strong>
                {row.variationLabel ? ` (${row.variationLabel})` : ""} a <strong>#{picked.adsProductId} · {picked.name}</strong>
              </p>
              <details open={picked.kit || components.length > 0}>
                <summary>Kit ou pacote (composição por venda){picked.kit ? " — obrigatório para este produto" : ""}</summary>
                <p className="hint">Cada venda deste anúncio consome os produtos abaixo. Sem composição = 1 unidade do produto escolhido.</p>
                {components.map((c, i) => (
                  <div key={c.productId} className="toolbar" style={{ marginBottom: 4 }}>
                    <span>
                      #{c.adsProductId} · {c.name}
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={c.quantity}
                      aria-label={`Quantidade de ${c.name}`}
                      style={{ width: 80 }}
                      onChange={(e) => setComponents(components.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setComponents(components.filter((_, j) => j !== i))}>
                      Remover
                    </button>
                  </div>
                ))}
                <ProductPicker
                  onPick={(p: PickedProduct) =>
                    !components.some((c) => c.productId === p.id) && setComponents([...components, { productId: p.id, adsProductId: p.adsProductId, name: p.name, quantity: 1 }])
                  }
                />
              </details>
              <label style={{ marginTop: 10 }}>
                Limite de quantidade anunciada (opcional)
                <input type="number" min={0} value={maxQuantity} onChange={(e) => setMaxQuantity(e.target.value)} style={{ width: 120, display: "block" }} />
              </label>
              <div className="actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={confirm}>
                  Confirmar vínculo
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPicked(null)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {row.linkStatus === "CONFIRMED" && (
        <div>
          {!confirmRemove ? (
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmRemove(true)}>
              Remover vínculo…
            </button>
          ) : (
            <div className="confirm-box">
              <p>Remover o vínculo de {row.marketplaceItemId}? Pedidos já mapeados não mudam; propostas de estoque abertas deixam de valer.</p>
              <button type="button" className="btn btn-danger-solid btn-sm" disabled={busy} onClick={remove}>
                Confirmar remoção
              </button>{" "}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmRemove(false)}>
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}
      {isLinked(row) && policy && (
        <div className="card" style={{ margin: 0 }}>
          <strong>Grupo de estoque do produto ADS #{row.linkAdsProductId}</strong>
          <p className="hint">
            Este produto abastece {row.productPools} estoque(s) no Mercado Livre. Com mais de um estoque independente, escolha uma regra de alocação — o saldo nunca é
            copiado para todos.
          </p>
          <div className="form-grid">
            <label>
              Reserva de segurança (un.)
              <input
                type="number"
                min={0}
                defaultValue={policy.safetyReserve ?? ""}
                placeholder="padrão"
                onBlur={(e) => savePolicy({ safetyReserve: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </label>
            <label>
              Alocação entre anúncios
              <select value={policy.allocationMode} onChange={(e) => savePolicy({ allocationMode: e.target.value as Policy["allocationMode"] })}>
                <option value="EXCLUSIVE">Exclusiva (um único estoque)</option>
                <option value="SPLIT_EVEN">Dividir igualmente</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={policy.autoSyncApproved} onChange={(e) => savePolicy({ autoSyncApproved: e.target.checked })} />
              Aprovado para sincronização automática
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export function LinkingPanel(props: {
  filter: string;
  filterLabels: Record<string, string>;
  q: string;
  rows: Row[];
  counts: Record<string, number>;
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn" | "info"; text: string } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState(false);

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };
  const selectedRows = props.rows.filter((r) => selected.has(r.id));
  const batchRows = selectedRows.filter(batchable);

  async function discover() {
    setBusy("discover");
    setFeedback({ kind: "info", text: "Lendo os anúncios da conta no Mercado Livre (somente leitura)…" });
    for (let round = 1; round <= 10; round++) {
      const r = await api<{ listed: number; fetched: number; complete: boolean; suggestions: { suggested: number; ambiguous: number } }>("/api/legacy-listings/discover", { method: "POST" });
      if (!r.ok) {
        setFeedback({ kind: "error", text: errorText(r) });
        break;
      }
      if (r.data.complete) {
        setFeedback({ kind: "success", text: `${r.data.listed} anúncio(s) na conta. Sugestões: ${r.data.suggestions.suggested} única(s), ${r.data.suggestions.ambiguous} ambígua(s).` });
        break;
      }
      setFeedback({ kind: "info", text: `Leitura parcial (${r.data.fetched} lidos nesta etapa); continuando… (${round}/10)` });
    }
    setBusy(null);
    router.refresh();
  }

  async function linkBatch() {
    setBusy("batch");
    const r = await api<{ linked: unknown[]; skipped: { id: string; reason: string }[] }>("/api/legacy-listings/map-batch", {
      method: "POST",
      body: { items: batchRows.map((r) => ({ id: r.id, productId: r.suggestedProductId })), confirm: true },
    });
    setBusy(null);
    setBatchConfirm(false);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    setFeedback({
      kind: r.data.skipped.length ? "warn" : "success",
      text: `${r.data.linked.length} vínculo(s) confirmado(s).${r.data.skipped.length ? ` Não vinculados: ${r.data.skipped.map((s) => s.reason).join("; ")}` : ""}`,
    });
    setSelected(new Set());
    router.refresh();
  }

  async function simulateSelected() {
    const itemIds = [...new Set(selectedRows.filter(isLinked).map((r) => r.marketplaceItemId))];
    if (!itemIds.length) return setFeedback({ kind: "warn", text: "Selecione anúncios já vinculados para simular." });
    setBusy("simulate");
    const r = await api("/api/stock-sync/preview", { method: "POST", body: { itemIds } });
    setBusy(null);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    setFeedback({ kind: "success", text: "Simulação concluída (nada foi enviado ao Mercado Livre). Veja as propostas abaixo." });
    router.refresh();
  }

  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const all = { filter: props.filter, q: props.q || undefined, ...o };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/anuncios/vinculacao?${p}`;
  };
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));

  return (
    <section aria-label="Vinculação de anúncios" style={{ marginBottom: 24 }}>
      <div className="toolbar" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Anúncios da conta</h2>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={discover}>
          {busy === "discover" ? "Lendo anúncios…" : "Atualizar lista de anúncios"}
        </button>
      </div>
      {feedback && <div className={`alert ${feedback.kind}`}>{feedback.text}</div>}
      <nav className="toolbar" aria-label="Filtros" style={{ marginBottom: 10 }}>
        {Object.entries(props.filterLabels).map(([k, label]) => (
          <a key={k} href={qs({ filter: k, page: undefined })} className={`btn btn-sm ${k === props.filter ? "btn-primary" : "btn-secondary"}`}>
            {label} ({props.counts[k] ?? 0})
          </a>
        ))}
      </nav>
      <form method="get" action="/anuncios/vinculacao" className="toolbar" role="search" style={{ marginBottom: 10 }}>
        <input type="hidden" name="filter" value={props.filter} />
        <input type="search" name="q" defaultValue={props.q} placeholder="MLB, SKU, título, ID ADS ou User Product" style={{ maxWidth: 360 }} />
        <button className="btn btn-secondary btn-sm" type="submit">
          Pesquisar
        </button>
      </form>
      {selected.size > 0 && (
        <div className="bulkbar">
          <span>{selected.size} selecionado(s)</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={!batchRows.length || !!busy} onClick={() => setBatchConfirm(true)}>
            Vincular sugestões inequívocas ({batchRows.length})
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={simulateSelected}>
            {busy === "simulate" ? "Simulando…" : "Simular atualização dos selecionados"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())}>
            Limpar seleção
          </button>
        </div>
      )}
      {batchConfirm && (
        <div className="confirm-box" style={{ marginBottom: 12 }}>
          <p>Confirmar os vínculos abaixo? Somente sugestões únicas por SKU ou GTIN com confiança alta. O servidor confere de novo cada uma.</p>
          <ul>
            {batchRows.map((r) => (
              <li key={r.id}>
                {r.marketplaceItemId}
                {r.variationLabel ? ` (${r.variationLabel})` : ""} → #{r.suggestedAdsProductId} · {r.suggestedProductName} ({SOURCE_LABEL[r.suggestionSource ?? ""]})
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={linkBatch}>
            Confirmar {batchRows.length} vínculo(s)
          </button>{" "}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setBatchConfirm(false)}>
            Cancelar
          </button>
        </div>
      )}
      {!props.rows.length ? (
        <div className="card empty-state">Nenhum anúncio neste filtro. Use “Atualizar lista de anúncios” para ler a conta.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos"
                    checked={props.rows.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(props.rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th></th>
                <th>Anúncio</th>
                <th>SKU / GTIN</th>
                <th>Status</th>
                <th className="num">Qtd. ML</th>
                <th>Produto ADS</th>
                <th className="num">Qtd. ADS</th>
                <th className="num">Diferença</th>
                <th>Vínculo</th>
                <th>Sincronização</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => {
                const st = listingStatusLabel(r.status);
                const link = LINK_LABEL[r.linkStatus];
                const ads = r.adsBranches ? Math.max(0, Math.floor(Number(r.adsTotal))) : null;
                const diff = isLinked(r) && ads !== null && r.availableQuantity !== null ? ads - r.availableQuantity : null;
                return (
                  <Fragment key={r.id}>
                    <tr className={selected.has(r.id) ? "selected" : undefined}>
                      <td>
                        <input type="checkbox" aria-label={`Selecionar ${r.marketplaceItemId}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                      <td>{r.thumbnail ? <img className="thumb" src={r.thumbnail} alt="" loading="lazy" /> : <span className="thumb empty">sem foto</span>}</td>
                      <td className="cell-name">
                        {r.permalink ? (
                          <a href={r.permalink} target="_blank" rel="noreferrer">
                            {r.marketplaceItemId}
                          </a>
                        ) : (
                          r.marketplaceItemId
                        )}
                        {r.origin === "EXTERNAL" && <span className="chip" style={{ marginLeft: 6 }}>legado</span>}
                        <small>{r.title ?? "—"}</small>
                        {r.variationLabel && <small>Variação: {r.variationLabel}</small>}
                        {r.userProductId && <small>User Product: {r.userProductId}</small>}
                      </td>
                      <td>
                        <small>{r.sellerSku ?? "—"}</small>
                        <small className="muted" style={{ display: "block" }}>
                          {r.gtins.join(", ") || "sem GTIN"}
                        </small>
                      </td>
                      <td>
                        <span className={`chip ${st.tone}`}>{st.text}</span>
                        {r.logisticType === "fulfillment" && <span className="chip warn" style={{ display: "block", marginTop: 4 }}>Full</span>}
                        {!r.manageable && r.logisticType !== "fulfillment" && <small className="muted" style={{ display: "block" }}>não gerenciável</small>}
                      </td>
                      <td className="num">{r.availableQuantity ?? "—"}</td>
                      <td>
                        {isLinked(r) ? (
                          <>
                            #{r.linkAdsProductId} · {r.linkProductName}
                            {r.componentCount > 0 && <small className="muted" style={{ display: "block" }}>kit: {r.componentCount} componente(s)</small>}
                            {r.productPools > 1 && <small className="muted" style={{ display: "block" }}>{r.productPools} estoques no ML</small>}
                          </>
                        ) : r.suggestedProductId ? (
                          <span className="muted">
                            sugerido: #{r.suggestedAdsProductId} · {r.suggestedProductName}
                          </span>
                        ) : r.candidateCount > 1 ? (
                          <span className="muted">{r.candidateCount} candidatos</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num" title={r.adsFetchedAt ? `Saldo consultado em ${formatDateTime(r.adsFetchedAt)}` : undefined}>
                        {isLinked(r) ? (r.adsBranches ? formatNumber(r.adsTotal) : <span className="muted">desconhecido</span>) : "—"}
                      </td>
                      <td className="num">{diff === null ? "—" : diff > 0 ? `+${diff}` : diff}</td>
                      <td>
                        <span className={`chip ${link.tone}`}>{link.text}</span>
                        {(r.mappingSource || r.suggestionSource) && (
                          <small className="muted" style={{ display: "block" }}>
                            {isLinked(r) ? `por ${SOURCE_LABEL[r.mappingSource ?? "EXISTING_LINK"] ?? r.mappingSource}` : SOURCE_LABEL[r.suggestionSource ?? ""]}
                            {!isLinked(r) && r.suggestionConfidence ? ` · ${CONFIDENCE_LABEL[r.suggestionConfidence]?.text}` : ""}
                          </small>
                        )}
                      </td>
                      <td>
                        {r.lastJobStatus ? (
                          <span className={`chip ${r.lastJobStatus === "SUCCEEDED" ? "ok" : r.lastJobStatus === "QUEUED" || r.lastJobStatus === "RUNNING" ? "info" : "warn"}`}>job {r.lastJobStatus}</span>
                        ) : r.lastProposalStatus ? (
                          <span className="chip">proposta {r.lastProposalStatus}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(open === r.id ? null : r.id)}>
                          {open === r.id ? "Fechar" : isLinked(r) ? "Detalhes" : "Vincular"}
                        </button>
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={12}>
                          <Detail
                            row={r}
                            onDone={(msg) => {
                              setFeedback({ kind: "success", text: msg });
                              setOpen(null);
                              router.refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span className="muted">
          {props.total} anúncio(s) · página {props.page} de {pages}
        </span>
        <div className="pages">
          {props.page > 1 && (
            <a className="btn btn-secondary btn-sm" href={qs({ page: props.page - 1 })}>
              Anterior
            </a>
          )}
          {props.page < pages && (
            <a className="btn btn-secondary btn-sm" href={qs({ page: props.page + 1 })}>
              Próxima
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
