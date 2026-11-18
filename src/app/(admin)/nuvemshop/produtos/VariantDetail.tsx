"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

interface Level {
  locationId: string;
  stock: number | null;
  locationName: string | null;
  mappingStatus: string | null;
  warehouseCode: string | null;
}

interface History {
  id: string;
  action: string;
  productId: number | null;
  adsProductId: number | null;
  actor: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION: Record<string, string> = {
  SUGGESTED: "sugerido",
  CONFIRMED: "confirmado",
  BULK_CONFIRMED: "confirmado em lote",
  CORRECTED: "corrigido",
  REJECTED: "sugestão recusada",
  REVOKED: "desvinculado",
  NEEDS_REVIEW: "enviado para revisão",
};

export function HistoryList({ items }: { items: History[] }) {
  if (!items.length) return <p className="muted">Sem histórico.</p>;
  return (
    <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
      {items.map((h) => (
        <li key={h.id}>
          <small>
            {formatDateTime(h.createdAt)} · {ACTION[h.action] ?? h.action}
            {h.adsProductId ? ` · ADS #${h.adsProductId}` : ""} · {h.actor}
            {h.details && typeof h.details.reason === "string" ? ` · ${h.details.reason}` : ""}
          </small>
        </li>
      ))}
    </ul>
  );
}

export function LevelsTable({ levels }: { levels: Level[] }) {
  if (!levels.length) return <p className="muted">A loja não informa estoque por localização para esta variante (estoque único).</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Localização</th>
          <th>Estoque</th>
          <th>Associação</th>
        </tr>
      </thead>
      <tbody>
        {levels.map((l) => (
          <tr key={l.locationId}>
            <td>{l.locationName ?? <small className="muted">{l.locationId}</small>}</td>
            <td>{l.stock ?? "desconhecido"}</td>
            <td>{l.mappingStatus === "MAPPED" ? `depósito ${l.warehouseCode}` : l.mappingStatus === "EXCLUDED" ? "excluída" : l.mappingStatus === "UNMAPPED" ? "não mapeada" : "localização não identificada"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Detalhe sob demanda (dados locais): estoque por localização e histórico de vínculo. */
export function VariantDetailToggle({ variantId }: { variantId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ levels: Level[]; history: History[]; row: { barcode: string | null; gtin: string | null; fetchedAt: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      const r = await api<{ levels: Level[]; history: History[]; row: { barcode: string | null; gtin: string | null; fetchedAt: string } }>(`/api/nuvemshop/products/${variantId}`);
      if (r.ok) setData(r.data);
      else setError(errorText(r));
    }
  }
  return (
    <div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={toggle} aria-expanded={open}>
        {open ? "Ocultar detalhes" : "Detalhes"}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          {error && <div className="alert error">{error}</div>}
          {!data && !error && <small className="muted">Carregando…</small>}
          {data && (
            <>
              <small className="muted">
                Código de barras: {data.row.barcode ?? "—"}
                {data.row.barcode && !data.row.gtin ? " (não é GTIN válido)" : ""} · lido em {formatDateTime(data.row.fetchedAt)}
              </small>
              <LevelsTable levels={data.levels} />
              <strong>Histórico do vínculo</strong>
              <HistoryList items={data.history} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
