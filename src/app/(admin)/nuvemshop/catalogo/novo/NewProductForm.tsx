"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { ProductPicker, type PickedProduct } from "../../../pedidos/ProductPicker";

export function NewProductForm() {
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string; href?: string } | null>(null);

  async function create() {
    if (!picked) return;
    setBusy(true);
    setMsg(null);
    const r = await api<{ nsProductId: string; variantId: string; reconciled: boolean }>("/api/nuvemshop/catalog", {
      method: "POST",
      body: {
        productId: picked.id,
        price: Number(price.replace(",", ".")),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(images.trim() ? { imageUrls: images.split(/\s+/).filter(Boolean) } : {}),
      },
    });
    setBusy(false);
    setMsg(
      r.ok
        ? { kind: "success", text: `Produto ${r.data.nsProductId} criado (oculto, estoque 0) e vinculado ao produto ADS #${picked.adsProductId}${r.data.reconciled ? " — resultado incerto reconciliado pelo SKU" : ""}.`, href: `/nuvemshop/catalogo/${r.data.nsProductId}` }
        : { kind: "error", text: errorText(r) },
    );
  }

  return (
    <section className="card">
      {msg && (
        <div className={`alert ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
          {msg.text} {msg.href && <a href={msg.href}>Abrir editor</a>}
        </div>
      )}
      <p className="hint">
        O integrador recusa a criação se o produto ADS já estiver vinculado a uma variante, se o SKU (padrão ADS-&lt;código&gt;) já existir na loja ou se houver uma criação anterior com
        resultado incerto. Kits são criados na Nuvemshop e vinculados com a composição.
      </p>
      <h2>1. Produto ADS</h2>
      {picked ? (
        <p>
          <strong>#{picked.adsProductId}</strong> {picked.name}{" "}
          <button className="btn btn-secondary btn-sm" onClick={() => setPicked(null)}>
            trocar
          </button>
        </p>
      ) : (
        <ProductPicker onPick={(p) => { setPicked(p); setName(p.name); }} />
      )}
      <h2>2. Dados na loja</h2>
      <div style={{ display: "grid", gap: 8 }}>
        <label>
          Nome
          <input value={name} maxLength={250} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Preço inicial (R$) — depois a automação de preço pode assumir
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" style={{ maxWidth: 160 }} />
        </label>
        <label>
          Descrição
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Imagens (URLs https públicas, separadas por espaço; até 9)
          <textarea rows={2} value={images} onChange={(e) => setImages(e.target.value)} />
        </label>
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={busy || !picked || !(Number(price.replace(",", ".")) > 0)} onClick={create}>
          {busy ? "Criando…" : "Criar produto oculto"}
        </button>
      </div>
    </section>
  );
}
