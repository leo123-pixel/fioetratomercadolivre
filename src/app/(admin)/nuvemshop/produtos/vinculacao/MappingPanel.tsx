"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { ProductPicker } from "@/app/(admin)/pedidos/ProductPicker";
import { api, errorText } from "@/lib/client-api";
import { formatMoney } from "@/lib/format";
import { CONFIDENCE_LABEL, CRITERION_LABEL, LINK_STATUS, nsStockLabel, optionLabel } from "../../NuvemshopTabs";
import { HistoryList, LevelsTable } from "../VariantDetail";

export interface Row {
  variantId: string;
  productId: string;
  productName: string | null;
  optionValues: unknown;
  sku: string | null;
  barcode: string | null;
  gtin: string | null;
  price: string | null;
  stockManagement: boolean | null;
  stock: number | null;
  isKit: boolean;
  syncStatus: string;
  imageSrc: string | null;
  linkStatus: "CONFIRMED" | "NEEDS_REVIEW" | "PENDING" | "AMBIGUOUS" | "UNLINKED";
  linkProductId: number | null;
  linkAdsProductId: number | null;
  linkProductName: string | null;
  linkCriterion: string | null;
  linkDecidedBy: string | null;
  reviewReason: string | null;
  componentCount: number;
  suggestionCount: number;
  suggestedProductId: number | null;
  suggestedAdsProductId: number | null;
  suggestedProductName: string | null;
  suggestionCriterion: string | null;
  suggestionConfidence: string | null;
  duplicateSku: boolean;
  duplicateGtin: boolean;
  adsQuantity: string | null;
  adsStatus: string | null;
  safeSellable: number | null;
  nsQuotaSimulated: number | null;
}

interface Candidate {
  productId: number;
  adsProductId: number;
  name: string;
  adsKit: boolean;
  source: string;
  confidence: string;
  evidence: { source: string; confidence: string; detail: string }[];
}

interface DetailData {
  candidates: Candidate[];
  ambiguous: boolean;
  levels: { locationId: string; stock: number | null; locationName: string | null; mappingStatus: string | null; warehouseCode: string | null }[];
  components: { productId: number; adsProductId: number; name: string; quantity: number }[];
  history: { id: string; action: string; productId: number | null; adsProductId: number | null; actor: string; details: Record<string, unknown> | null; createdAt: string }[];
}

const safeBatch = (r: Row) =>
  r.linkStatus === "PENDING" && r.suggestionConfidence === "HIGH" && ["EXISTING_LINK", "SKU_MATCH", "GTIN_MATCH"].includes(r.suggestionCriterion ?? "") && !r.duplicateSku && !r.duplicateGtin && !r.isKit;

function Detail({ row, onDone }: { row: Row; onDone: (msg: string) => void }) {
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<{ productId: number; adsProductId: number; name: string; kit?: boolean } | null>(null);
  const [components, setComponents] = useState<{ productId: number; adsProductId: number; name: string; quantity: number }[]>([]);
  const [revokeReason, setRevokeReason] = useState("");
  const [showRevoke, setShowRevoke] = useState(false);
  const needsComposition = row.isKit || Boolean(picked?.kit);

  useEffect(() => {
    void (async () => {
      const r = await api<DetailData>(`/api/nuvemshop/products/${row.variantId}`);
      if (r.ok) {
        setData(r.data);
        if (r.data.components.length) setComponents(r.data.components);
      } else setError(errorText(r));
    })();
  }, [row.variantId]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    const r = await api("/api/nuvemshop/mappings", { method: "POST", body });
    setBusy(false);
    if (r.ok) onDone(ok);
    else setError(errorText(r));
  }

  const confirm = () =>
    picked &&
    post(
      {
        action: "confirm",
        variantId: row.variantId,
        productId: picked.productId,
        components: needsComposition ? components.map((c) => ({ productId: c.productId, quantity: c.quantity })) : undefined,
      },
      `Vínculo confirmado: variante ${row.variantId} → ADS #${picked.adsProductId}`,
    );

  return (
    <div style={{ display: "grid", gap: 12, padding: "8px 0" }}>
      {error && <div className="alert error">{error}</div>}
      {!data && !error && <span className="muted">Carregando candidatos…</span>}
      {row.linkStatus === "NEEDS_REVIEW" && <div className="alert warn">Vínculo em revisão: {row.reviewReason}. Confirme de novo (mesmo produto ou outro) ou desvincule.</div>}
      {data && (
        <div>
          <strong>Candidatos ADS</strong>
          {data.ambiguous && (
            <span className="chip warn" style={{ marginLeft: 8 }}>
              ambíguo: escolha manual
            </span>
          )}
          {!data.candidates.length && <p className="muted">Nenhum candidato por vínculo existente, SKU, GTIN ou código do fabricante.</p>}
          <ul style={{ listStyle: "none", padding: 0, margin: "6px 0", display: "grid", gap: 6 }}>
            {data.candidates.map((c) => (
              <li key={c.productId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  className={`btn btn-sm ${picked?.productId === c.productId ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setPicked({ productId: c.productId, adsProductId: c.adsProductId, name: c.name, kit: c.adsKit })}
                >
                  #{c.adsProductId} · {c.name}
                </button>
                <span className="chip">{CRITERION_LABEL[c.source] ?? c.source}</span>
                <span className={`chip ${CONFIDENCE_LABEL[c.confidence]?.tone ?? ""}`}>{CONFIDENCE_LABEL[c.confidence]?.text ?? c.confidence}</span>
                {c.adsKit && <span className="chip warn">kit na ADS</span>}
                <small className="muted">{c.evidence.map((e) => e.detail).join(" · ")}</small>
                {row.linkStatus !== "CONFIRMED" && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => post({ action: "reject", variantId: row.variantId, productId: c.productId }, "Sugestão recusada")}>
                    Rejeitar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <strong>Buscar produto ADS</strong>
        <ProductPicker initialQuery={row.sku ?? ""} onPick={(p) => setPicked({ productId: p.id, adsProductId: p.adsProductId, name: p.name })} />
      </div>
      {needsComposition && (
        <div className="confirm-box" style={{ borderStyle: "solid", borderColor: "var(--warn-fg)" }}>
          <p>
            <strong>Kit:</strong> informe os produtos ADS e a quantidade de cada um por venda. Um kit nunca é vinculado como um SKU simples.
          </p>
          {components.map((c, i) => (
            <div key={c.productId} className="inline-form" style={{ marginBottom: 6 }}>
              <span>
                #{c.adsProductId} · {c.name}
              </span>
              <input
                type="number"
                min={1}
                max={1000}
                value={c.quantity}
                aria-label={`Quantidade de ${c.name}`}
                style={{ width: 90 }}
                onChange={(e) => setComponents(components.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
              />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setComponents(components.filter((_, j) => j !== i))}>
                Remover
              </button>
            </div>
          ))}
          <ProductPicker
            onPick={(p) => !components.some((c) => c.productId === p.id) && setComponents([...components, { productId: p.id, adsProductId: p.adsProductId, name: p.name, quantity: 1 }])}
          />
        </div>
      )}
      <div className="toolbar">
        <button type="button" className="btn btn-primary" disabled={busy || !picked || (needsComposition && !components.length) || row.syncStatus !== "ACTIVE"} onClick={confirm}>
          {picked ? `Confirmar vínculo com ADS #${picked.adsProductId}` : "Escolha um produto ADS"}
        </button>
        {(row.linkStatus === "CONFIRMED" || row.linkStatus === "NEEDS_REVIEW") && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setShowRevoke(true)}>
            Desvincular
          </button>
        )}
      </div>
      {showRevoke && (
        <div className="confirm-box">
          <p>A desvinculação fica no histórico. Informe o motivo:</p>
          <div className="inline-form">
            <input type="text" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} placeholder="Motivo" aria-label="Motivo da desvinculação" />
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={busy || revokeReason.trim().length < 3}
              onClick={() => post({ action: "revoke", variantId: row.variantId, reason: revokeReason.trim() }, "Variante desvinculada")}
            >
              Confirmar desvinculação
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setShowRevoke(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {data && (
        <div className="two-col">
          <div>
            <strong>Estoque por localização (Nuvemshop)</strong>
            <LevelsTable levels={data.levels} />
          </div>
          <div>
            <strong>Histórico</strong>
            <HistoryList items={data.history} />
          </div>
        </div>
      )}
    </div>
  );
}

export function MappingPanel(props: {
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
  const [open, setOpen] = useState<string | null>(props.rows.length === 1 ? props.rows[0].variantId : null);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const batchable = props.rows.filter(safeBatch);
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const href = (p: Record<string, string | number>) => {
    const u = new URLSearchParams();
    const all = { filter: props.filter, q: props.q, page: props.page, ...p };
    for (const [k, v] of Object.entries(all)) if (v !== "" && !(k === "page" && v === 1)) u.set(k, String(v));
    return `?${u.toString()}`;
  };

  async function bulk() {
    setBusy(true);
    setMsg(null);
    const r = await api<{ confirmed: number; skipped: { variantId: string; reason: string }[] }>("/api/nuvemshop/mappings", {
      method: "POST",
      body: { action: "bulk_confirm_safe", variantIds: [...selected] },
    });
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: "success", text: `${r.data.confirmed} vínculo(s) confirmado(s)${r.data.skipped.length ? `; ${r.data.skipped.length} ignorado(s): ${[...new Set(r.data.skipped.map((s) => s.reason))].join(", ")}` : ""}.` });
      setSelected(new Set());
      router.refresh();
    } else setMsg({ kind: "error", text: errorText(r) });
  }

  async function refreshSuggestions() {
    setBusy(true);
    const r = await api<{ evaluated: number; suggested: number; ambiguous: number; needsReview: number }>("/api/nuvemshop/mappings", { method: "POST", body: { action: "refresh_suggestions" } });
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: "success", text: `Sugestões recalculadas: ${r.data.evaluated} variante(s) avaliada(s), ${r.data.suggested} nova(s), ${r.data.ambiguous} ambígua(s), ${r.data.needsReview} para revisão.` });
      router.refresh();
    } else setMsg({ kind: "error", text: errorText(r) });
  }

  return (
    <section className="card">
      {msg && (
        <div className={`alert ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      <nav className="tabs" aria-label="Filtros">
        {Object.entries(props.filterLabels).map(([k, label]) => (
          <a key={k} href={href({ filter: k, page: 1 })} aria-current={k === props.filter ? "page" : undefined}>
            {label} ({props.counts[k] ?? 0})
          </a>
        ))}
      </nav>
      <form className="toolbar" method="get" style={{ marginBottom: 12 }}>
        <input type="hidden" name="filter" value={props.filter} />
        <input type="search" name="q" defaultValue={props.q} placeholder="Nome, SKU, código de barras, Variant ID ou ID ADS" aria-label="Busca" style={{ maxWidth: 360 }} />
        <button type="submit" className="btn btn-secondary">
          Buscar
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={refreshSuggestions}>
          Recalcular sugestões
        </button>
      </form>
      {batchable.length > 0 && (
        <div className="bulkbar">
          <label>
            <input
              type="checkbox"
              checked={batchable.every((r) => selected.has(r.variantId))}
              onChange={(e) => setSelected(e.target.checked ? new Set(batchable.map((r) => r.variantId)) : new Set())}
            />{" "}
            Selecionar as {batchable.length} correspondências seguras desta página
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !selected.size} onClick={bulk}>
            Confirmar {selected.size} em lote
          </button>
          <small className="muted">Só SKU no padrão ADS, GTIN válido ou vínculo existente, com confiança alta, sem duplicidade e sem kit.</small>
        </div>
      )}
      {props.rows.length === 0 ? (
        <div className="empty-state">Nenhuma variante neste filtro.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Imagem</th>
                <th>Produto Nuvemshop</th>
                <th>SKU / GTIN</th>
                <th>Preço</th>
                <th>Estoque NS</th>
                <th>Sugerido</th>
                <th>Confirmado</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => {
                const st = LINK_STATUS[r.linkStatus];
                const stock = nsStockLabel(r.stockManagement, r.stock);
                const opt = optionLabel(r.optionValues);
                return (
                  <Fragment key={r.variantId}>
                    <tr>
                      <td>
                        {safeBatch(r) && (
                          <input
                            type="checkbox"
                            aria-label={`Selecionar ${r.variantId}`}
                            checked={selected.has(r.variantId)}
                            onChange={(e) => {
                              const s = new Set(selected);
                              if (e.target.checked) s.add(r.variantId);
                              else s.delete(r.variantId);
                              setSelected(s);
                            }}
                          />
                        )}
                      </td>
                      <td>
                        {r.imageSrc ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img className="thumb" src={r.imageSrc} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="thumb empty">sem imagem</span>
                        )}
                      </td>
                      <td className="cell-name">
                        {r.productName ?? "—"}
                        {opt && <small>{opt}</small>}
                        <small>
                          Product {r.productId} · Variant {r.variantId}
                        </small>
                        {r.isKit && <span className="chip warn">kit</span>} {r.syncStatus === "REMOVED" && <span className="chip danger">removida na loja</span>}
                      </td>
                      <td>
                        {r.sku ?? <span className="chip warn">sem SKU</span>} {r.duplicateSku && <span className="chip danger">SKU duplicado</span>}
                        <br />
                        <small className="muted">{r.gtin ?? (r.barcode ? `${r.barcode} (inválido)` : "sem GTIN")}</small> {r.duplicateGtin && <span className="chip warn">GTIN duplicado</span>}
                      </td>
                      <td>{r.price ? formatMoney(r.price) : "—"}</td>
                      <td>
                        <span className={`chip ${stock.tone}`}>{stock.text}</span>
                        {r.adsQuantity !== null && (
                          <small className="muted">
                            <br />
                            ADS {r.adsQuantity}
                          </small>
                        )}
                      </td>
                      <td>
                        {r.suggestedAdsProductId ? (
                          <>
                            #{r.suggestedAdsProductId} · {r.suggestedProductName}
                            <br />
                            <span className="chip">{CRITERION_LABEL[r.suggestionCriterion ?? ""] ?? r.suggestionCriterion}</span>{" "}
                            <span className={`chip ${CONFIDENCE_LABEL[r.suggestionConfidence ?? ""]?.tone ?? ""}`}>{CONFIDENCE_LABEL[r.suggestionConfidence ?? ""]?.text}</span>
                            {r.suggestionCount > 1 && <span className="chip warn"> +{r.suggestionCount - 1}</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {r.linkAdsProductId ? (
                          <>
                            #{r.linkAdsProductId} · {r.linkProductName}
                            <br />
                            <small className="muted">
                              {CRITERION_LABEL[r.linkCriterion ?? ""] ?? r.linkCriterion} · {r.linkDecidedBy}
                              {r.componentCount ? ` · kit (${r.componentCount} itens)` : ""}
                            </small>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <span className={`chip ${st.tone}`}>{st.text}</span>
                        <br />
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(open === r.variantId ? null : r.variantId)} aria-expanded={open === r.variantId}>
                          {open === r.variantId ? "Fechar" : r.linkStatus === "CONFIRMED" ? "Revisar" : "Vincular"}
                        </button>
                      </td>
                    </tr>
                    {open === r.variantId && (
                      <tr>
                        <td colSpan={9}>
                          <Detail
                            row={r}
                            onDone={(text) => {
                              setMsg({ kind: "success", text });
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
          {props.total} variante(s) · página {props.page} de {pages}
        </span>
        <span className="pages">
          {props.page > 1 && (
            <a className="btn btn-secondary btn-sm" href={href({ page: props.page - 1 })}>
              Anterior
            </a>
          )}
          {props.page < pages && (
            <a className="btn btn-secondary btn-sm" href={href({ page: props.page + 1 })}>
              Próxima
            </a>
          )}
        </span>
      </div>
    </section>
  );
}
