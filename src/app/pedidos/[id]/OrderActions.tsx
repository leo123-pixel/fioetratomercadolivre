"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";

/** Ações de LEITURA do pedido. Não há (de propósito) ação de envio ao ERP nesta fase. */
export function OrderActions({ id, hasRaw }: { id: string; hasRaw: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [raw, setRaw] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setMsg(null);
    const r = await api<{ result: { adsImportStatus: string; mappingStatus: string } }>(`/api/orders/${id}/refresh`, { body: {} });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "error", text: errorText(r) });
    setMsg({ kind: "success", text: `Pedido relido no Mercado Livre: ${r.data.result.mappingStatus} · ${r.data.result.adsImportStatus}.` });
    router.refresh();
  }

  async function showRaw() {
    if (raw) return setRaw(null);
    if (!window.confirm("O JSON original contém dados pessoais do comprador. Exibir apenas se necessário. Continuar?")) return;
    const r = await api<{ raw: unknown }>(`/api/orders/${id}/raw`);
    if (!r.ok) return setMsg({ kind: "error", text: errorText(r) });
    setRaw(JSON.stringify(r.data.raw, null, 2));
  }

  return (
    <>
      <div className="actions">
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={refresh}>
          {busy ? "Consultando…" : "Reler no Mercado Livre"}
        </button>
        {hasRaw && (
          <button className="btn btn-secondary btn-sm" type="button" onClick={showRaw}>
            {raw ? "Ocultar JSON original" : "Ver JSON original (acesso restrito)"}
          </button>
        )}
        <button className="btn btn-primary btn-sm" type="button" disabled title="Integração com a ADS ainda não habilitada">
          Enviar para ADS (indisponível nesta fase)
        </button>
      </div>
      {msg && (
        <div className={`alert ${msg.kind}`} role="status" style={{ marginTop: 10 }}>
          {msg.text}
        </div>
      )}
      {raw && <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", maxHeight: 480, overflow: "auto" }}>{raw}</pre>}
    </>
  );
}
