"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { DRAFT_STATUS_LABEL, formatDateTime, formatMoney, formatNumber } from "@/lib/format";

interface Problem {
  code: string;
  message: string;
}

export interface DraftView {
  id: number;
  title: string | null;
  description: string | null;
  selectedPriceTable: string | null;
  selectedBranchId: string | null;
  referencePrice: string | null;
  listingPrice: string | null;
  listingQuantity: number | null;
  marketplaceCategoryId: string | null;
  marketplaceAttributes: { id: string; name?: string; value_name?: string | null }[];
  status: string;
  updatedAt: string;
  readiness: { blocking: Problem[]; warnings: Problem[] };
}

const TITLE_MAX = 60;

function toInputMoney(v: string | null): string {
  if (!v) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : v;
}

export function DraftEditor(props: {
  productId: number;
  productInactive: boolean;
  suggestedTitle: string;
  initial: DraftView | null;
  priceOptions: { code: string; branch: string; price: string; description: string | null }[];
  defaultTable: string | null;
  tables: { code: string; description: string; inactive: boolean }[];
  stockTotal: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  const [title, setTitle] = useState(props.initial?.title ?? "");
  const [description, setDescription] = useState(props.initial?.description ?? "");
  const [priceKey, setPriceKey] = useState(
    props.initial?.selectedPriceTable ? `${props.initial.selectedPriceTable}|${props.initial.selectedBranchId ?? ""}` : "",
  );
  const [listingPrice, setListingPrice] = useState(toInputMoney(props.initial?.listingPrice ?? null));
  const [quantity, setQuantity] = useState(props.initial?.listingQuantity?.toString() ?? "");
  const [category, setCategory] = useState(props.initial?.marketplaceCategoryId ?? "");
  const [attributes, setAttributes] = useState(JSON.stringify(props.initial?.marketplaceAttributes ?? [], null, 2));

  if (!draft) {
    return (
      <section className="card" aria-labelledby="rascunho">
        <h2 id="rascunho">Preparação para o Mercado Livre</h2>
        <p className="muted">
          Crie um rascunho para editar título, descrição, preço e quantidade do futuro anúncio. Nada é publicado no Mercado Livre nesta etapa.
        </p>
        {props.productInactive ? (
          <div className="alert warn">Produto inativo na ADS: rascunhos não são criados para produtos inativos.</div>
        ) : (
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ created: { draftId: number }[] }>("/api/listing-drafts", { body: { productId: props.productId } });
                if (!r.ok) setFeedback({ kind: "error", text: errorText(r) });
                else router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            Criar rascunho
          </button>
        )}
        {feedback && <div className={`alert ${feedback.kind}`}>{feedback.text}</div>}
      </section>
    );
  }

  const selectedOption = props.priceOptions.find((o) => `${o.code}|${o.branch}` === priceKey);
  const status = DRAFT_STATUS_LABEL[draft.status] ?? { text: draft.status, tone: "" };

  async function save(nextStatus?: "DRAFT" | "READY" | "ARCHIVED") {
    setBusy(true);
    setFeedback(null);
    setProblems([]);
    let parsedAttributes: unknown;
    try {
      parsedAttributes = attributes.trim() ? JSON.parse(attributes) : [];
      if (!Array.isArray(parsedAttributes)) throw new Error();
    } catch {
      setBusy(false);
      return setFeedback({ kind: "error", text: "Atributos: informe uma lista JSON válida, ex.: [{\"id\":\"BRAND\",\"value_name\":\"L'Oréal\"}]" });
    }
    const [table, branch] = priceKey ? priceKey.split("|") : [null, null];
    const body: Record<string, unknown> = {
      title: title.trim() || null,
      description: description.trim() || null,
      selectedPriceTable: table || null,
      selectedBranchId: branch || null,
      listingPrice: listingPrice.trim() || null,
      listingQuantity: quantity.trim() === "" ? null : Number(quantity),
      marketplaceCategoryId: category.trim() || null,
      marketplaceAttributes: parsedAttributes,
    };
    if (nextStatus) body.status = nextStatus;
    try {
      const r = await api<{ draft: DraftView; readiness: DraftView["readiness"] }>(`/api/listing-drafts/${draft!.id}`, { method: "PATCH", body });
      if (r.status === 422 && (r.data as { readiness?: DraftView["readiness"] }).readiness) {
        setProblems((r.data as { readiness: DraftView["readiness"] }).readiness.blocking);
        return setFeedback({ kind: "error", text: "O rascunho ainda não atende aos requisitos para ficar pronto. Nada foi alterado." });
      }
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setDraft({ ...r.data.draft, readiness: r.data.readiness, marketplaceAttributes: (r.data.draft.marketplaceAttributes ?? []) as DraftView["marketplaceAttributes"] });
      setFeedback({
        kind: "success",
        text: nextStatus === "READY" ? "Rascunho marcado como pronto. Nenhum anúncio foi publicado." : "Rascunho salvo.",
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="rascunho">
      <div className="status-row">
        <h2 id="rascunho">Preparação para o Mercado Livre</h2>
        <span className={`chip ${status.tone}`}>{status.text}</span>
      </div>
      <p className="muted">Rascunho salvo em {formatDateTime(draft.updatedAt)}. Nenhuma informação é enviada ao Mercado Livre nesta etapa.</p>

      <div className="form-grid">
        <div className="full">
          <label htmlFor="d-title">Título</label>
          <input id="d-title" type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <p className={title.trim().length > TITLE_MAX ? "hint warn" : "hint"}>
            {title.trim().length}/{TITLE_MAX} caracteres (limite do Mercado Livre).{" "}
            {props.suggestedTitle && title !== props.suggestedTitle && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setTitle(props.suggestedTitle)}>
                Usar nome do produto
              </button>
            )}
          </p>
        </div>
        <div className="full">
          <label htmlFor="d-desc">Descrição</label>
          <textarea id="d-desc" value={description} maxLength={50_000} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label htmlFor="d-table">Tabela de preço de referência</label>
          <select id="d-table" value={priceKey} onChange={(e) => setPriceKey(e.target.value)}>
            <option value="">— sem referência —</option>
            {props.priceOptions.map((o) => (
              <option key={`${o.code}|${o.branch}`} value={`${o.code}|${o.branch}`}>
                {o.code} · filial {o.branch} · {formatMoney(o.price)}
                {o.description ? ` (${o.description})` : ""}
                {o.code === props.defaultTable ? " — padrão" : ""}
              </option>
            ))}
          </select>
          <p className="hint">
            Somente preços ativos. Referência salva: {formatMoney(draft.referencePrice)}
            {selectedOption ? ` · selecionada agora: ${formatMoney(selectedOption.price)}` : ""}
          </p>
        </div>
        <div>
          <label htmlFor="d-price">Preço de publicação (R$)</label>
          <input id="d-price" type="text" inputMode="decimal" value={listingPrice} placeholder="0,00" onChange={(e) => setListingPrice(e.target.value)} />
          <p className="hint">
            Definido pelo operador; nenhum desconto ou margem é aplicado automaticamente.{" "}
            {selectedOption && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setListingPrice(toInputMoney(selectedOption.price))}>
                Copiar referência
              </button>
            )}
          </p>
        </div>
        <div>
          <label htmlFor="d-qty">Quantidade para publicação</label>
          <input id="d-qty" type="number" min={0} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <p className="hint">Estoque consultado: {props.stockTotal !== null ? formatNumber(props.stockTotal) : "desconhecido"}</p>
        </div>
        <div>
          <label htmlFor="d-cat">Categoria Mercado Livre (fase seguinte)</label>
          <input id="d-cat" type="text" value={category} placeholder="MLB1234" maxLength={20} onChange={(e) => setCategory(e.target.value.toUpperCase())} />
        </div>
        <div className="full">
          <label htmlFor="d-attr">Atributos Mercado Livre (JSON, fase seguinte)</label>
          <textarea id="d-attr" value={attributes} style={{ minHeight: 80, fontFamily: "monospace", fontSize: "0.85rem" }} onChange={(e) => setAttributes(e.target.value)} />
        </div>
      </div>

      {(problems.length > 0 || draft.readiness.blocking.length > 0 || draft.readiness.warnings.length > 0) && (
        <div className={`alert ${problems.length ? "error" : "warn"}`} style={{ marginTop: 14 }}>
          <strong>{problems.length ? "Pendências para marcar como pronto:" : "Verificação para publicação futura:"}</strong>
          <ul className="problems">
            {(problems.length ? problems : draft.readiness.blocking).map((p) => (
              <li key={p.code}>{p.message}</li>
            ))}
            {!problems.length &&
              draft.readiness.warnings.map((p) => (
                <li key={p.code}>
                  <em>Aviso:</em> {p.message}
                </li>
              ))}
          </ul>
        </div>
      )}

      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status" style={{ marginTop: 10 }}>
          {feedback.text}
        </div>
      )}

      <div className="actions sticky-actions">
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => save()}>
          {busy ? "Salvando…" : "Salvar rascunho"}
        </button>
        {draft.status !== "READY" ? (
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => save("READY")}>
            Salvar e marcar como pronto
          </button>
        ) : (
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => save("DRAFT")}>
            Voltar para edição
          </button>
        )}
        {draft.status !== "ARCHIVED" && (
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => save("ARCHIVED")}>
            Arquivar
          </button>
        )}
      </div>
    </section>
  );
}
