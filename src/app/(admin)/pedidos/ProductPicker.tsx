"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";

export interface PickedProduct {
  id: number;
  adsProductId: number;
  name: string;
}

/** Busca no catálogo importado da ADS (nome, código do fabricante, EAN ou ID ADS). Escolha sempre explícita. */
export function ProductPicker({ initialQuery, onPick }: { initialQuery?: string; onPick: (p: PickedProduct) => void }) {
  const [q, setQ] = useState(initialQuery ?? "");
  const [items, setItems] = useState<PickedProduct[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setItems([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      const r = await api<{ items: PickedProduct[] }>(`/api/products?q=${encodeURIComponent(term)}&status=active&pageSize=10`);
      setLoading(false);
      if (r.ok) setItems(r.data.items.map((i) => ({ id: i.id, adsProductId: i.adsProductId, name: i.name })));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto ADS por nome, código ou ID ADS" aria-label="Buscar produto ADS" />
      {loading && <small className="muted">Buscando…</small>}
      {items.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "6px 0", maxHeight: 220, overflow: "auto" }}>
          {items.map((p) => (
            <li key={p.id} style={{ marginBottom: 4 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onPick(p)} style={{ textAlign: "left", width: "100%" }}>
                #{p.adsProductId} · {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
