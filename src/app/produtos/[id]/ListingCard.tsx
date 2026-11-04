"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { DRAFT_STATUS_LABEL, listingStatusLabel } from "@/lib/format";

/** Resumo do anúncio do produto e acesso ao editor completo (/anuncios/preparar/[id]). */
export function ListingCard(props: {
  productId: number;
  productInactive: boolean;
  draft: { id: number; status: string; marketplaceItemId: string | null; permalink: string | null; listingStatus: string | null } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = props.draft
    ? props.draft.marketplaceItemId
      ? listingStatusLabel(props.draft.listingStatus)
      : DRAFT_STATUS_LABEL[props.draft.status] ?? { text: props.draft.status, tone: "" }
    : null;

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ created: { draftId: number }[]; skipped: { draftId?: number; reason: string }[] }>("/api/listing-drafts", { body: { productId: props.productId } });
      const id = r.data.created?.[0]?.draftId ?? r.data.skipped?.[0]?.draftId;
      if (r.ok && id) return router.push(`/anuncios/preparar/${id}`);
      setError(r.ok ? "Não foi possível criar o rascunho." : errorText(r));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="anuncio">
      <div className="status-row">
        <h2 id="anuncio">Anúncio no Mercado Livre</h2>
        {status && <span className={`chip ${status.tone}`}>{status.text}</span>}
      </div>
      {props.draft?.marketplaceItemId ? (
        <p>
          Publicado como <strong>{props.draft.marketplaceItemId}</strong>.{" "}
          {props.draft.permalink && (
            <a href={props.draft.permalink} target="_blank" rel="noopener noreferrer">
              Abrir no Mercado Livre
            </a>
          )}
        </p>
      ) : (
        <p className="muted">Prepare o anúncio (categoria, atributos, preço, imagens), valide e publique manualmente. Salvar nunca publica.</p>
      )}
      <div className="actions">
        {props.draft ? (
          <a className="btn btn-primary" href={`/anuncios/preparar/${props.draft.id}`}>
            {props.draft.marketplaceItemId ? "Ver anúncio e histórico" : "Abrir editor do anúncio"}
          </a>
        ) : props.productInactive ? (
          <span className="alert warn" style={{ margin: 0 }}>
            Produto inativo na ADS: não é sugerido para publicação.
          </span>
        ) : (
          <button className="btn btn-primary" type="button" disabled={busy} onClick={prepare}>
            {busy ? "Preparando…" : "Preparar anúncio"}
          </button>
        )}
      </div>
      {error && <div className="alert error">{error}</div>}
    </section>
  );
}
