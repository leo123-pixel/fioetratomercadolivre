"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";

type Feedback = { kind: "success" | "error" | "warn"; text: string } | null;

/** Nova consulta à ADS só deste produto (leitura). */
export function RefreshButtons({ productId }: { productId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function refresh(scopes: string[]) {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api<{ result: { prices?: { received: number }; stock?: { received: number }; invalidItems: number } }>(
        `/api/products/${productId}/refresh`,
        { body: { scopes } },
      );
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      const res = r.data.result;
      const parts = [];
      if (res.prices) parts.push(`${res.prices.received} preço(s)`);
      if (res.stock) parts.push(`${res.stock.received} saldo(s) de estoque`);
      if (scopes.includes("product")) parts.push("cadastro");
      setFeedback({ kind: res.invalidItems ? "warn" : "success", text: `Consultado na ADS: ${parts.join(", ")}.${res.invalidItems ? ` ${res.invalidItems} item(ns) inválido(s) ignorado(s).` : ""}` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => refresh(["prices", "stock"])}>
          {busy ? "Consultando…" : "Atualizar preço e estoque"}
        </button>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => refresh(["product", "prices", "stock"])}>
          Atualizar tudo
        </button>
      </div>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status" style={{ marginTop: 8, marginBottom: 0 }}>
          {feedback.text}
        </div>
      )}
    </div>
  );
}

/** Nome comercial personalizado (preservado nas próximas importações). */
export function NameEditor({ productId, nameCustom, nameOriginal }: { productId: number; nameCustom: string | null; nameOriginal: string }) {
  const router = useRouter();
  const [value, setValue] = useState(nameCustom ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function save(next: string | null) {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api(`/api/products/${productId}`, { method: "PATCH", body: { nameCustom: next } });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setFeedback({ kind: "success", text: next ? "Nome personalizado salvo." : "Voltou a usar a descrição da ADS." });
      if (!next) setValue("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label htmlFor="name-custom">Nome comercial (opcional)</label>
      <input id="name-custom" type="text" value={value} maxLength={200} placeholder={nameOriginal} onChange={(e) => setValue(e.target.value)} />
      <p className="hint">Usado no catálogo e como sugestão de título. Nunca é sobrescrito pela importação da ADS.</p>
      <div className="toolbar">
        <button className="btn btn-primary btn-sm" type="button" disabled={busy || value.trim() === (nameCustom ?? "")} onClick={() => save(value.trim() || null)}>
          Salvar nome
        </button>
        {nameCustom && (
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => save(null)}>
            Usar descrição da ADS
          </button>
        )}
      </div>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status" style={{ marginTop: 8 }}>
          {feedback.text}
        </div>
      )}
    </div>
  );
}
