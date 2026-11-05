"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { ProductPicker, type PickedProduct } from "../ProductPicker";
import { BarcodeSuggestions } from "./BarcodeSuggestions";

interface Group {
  itemId: string;
  variationId: string;
  sellerSku: string | null;
  title: string | null;
  orders: number;
  units: string;
  sampleOrderId: string;
  sampleLineKey: string;
}

interface Mapping {
  id: string;
  mappingType: "ITEM" | "SKU";
  itemId: string | null;
  variationId: string;
  sellerSku: string | null;
  adsProductId: number;
  productId: number;
  productName: string;
  createdBy: string;
  createdAt: string;
  usedBy: number;
}

type Scope = "ITEM" | "SKU" | "ORDER_LINE";

function GroupRow({ g, focused, onDone }: { g: Group; focused: boolean; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(focused);
  const [scope, setScope] = useState<Scope>("ITEM");
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(replace = false) {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const body =
      scope === "ITEM"
        ? { scope, productId: picked.id, itemId: g.itemId, variationId: g.variationId || null, replace }
        : scope === "SKU"
          ? { scope, productId: picked.id, sellerSku: g.sellerSku, replace }
          : { scope, productId: picked.id, orderInboxId: g.sampleOrderId, lineKey: g.sampleLineKey };
    const r = await api<{ remapped: { mapped: number; orders: number } }>("/api/mappings", { body });
    setBusy(false);
    if (r.status === 409 && r.data.error === "mapping_exists") {
      if (window.confirm(`${r.data.message}. Substituir pelo produto #${picked.adsProductId}? Vale para pedidos futuros; os já mapeados não mudam.`)) return save(true);
      return;
    }
    if (!r.ok) return setError(errorText(r));
    onDone(`Vínculo salvo: ${r.data.remapped.mapped} linha(s) de ${r.data.remapped.orders} pedido(s) agora mapeada(s).`);
  }

  return (
    <>
      <tr>
        <td>
          <a href={`https://produto.mercadolivre.com.br/${g.itemId.replace(/^MLB/, "MLB-")}`} target="_blank" rel="noopener noreferrer">
            {g.itemId}
          </a>
          {g.variationId && <small className="muted" style={{ display: "block" }}>variação {g.variationId}</small>}
        </td>
        <td>{g.title ?? "—"}</td>
        <td>{g.sellerSku ?? <span className="muted">sem SKU</span>}</td>
        <td className="num">{g.orders}</td>
        <td className="num">{g.units}</td>
        <td>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setOpen(!open)}>
            {open ? "Fechar" : "Mapear"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <div className="card" style={{ margin: 0 }}>
              <p style={{ marginTop: 0 }}>
                <strong>1. Procure o produto da ADS</strong> que corresponde a &quot;{g.title ?? g.itemId}&quot;. Digite marca e nome (por exemplo, as primeiras palavras do
                título), o código do fabricante, o EAN ou o ID ADS.
              </p>
              <ProductPicker initialQuery="" onPick={setPicked} />
              <p>
                <strong>2. Escolha até onde vale o vínculo:</strong>
              </p>
              <fieldset style={{ border: 0, padding: 0, margin: "0 0 8px" }}>
                <label style={{ display: "block" }}>
                  <input type="radio" checked={scope === "ITEM"} onChange={() => setScope("ITEM")} /> <strong>Este anúncio{g.variationId ? " (esta variação)" : ""}</strong> — vale para
                  as {g.orders} venda(s) já recebida(s) e para todas as próximas <em>(recomendado)</em>
                </label>
                <label style={{ display: "block", opacity: g.sellerSku ? 1 : 0.5 }}>
                  <input type="radio" disabled={!g.sellerSku} checked={scope === "SKU"} onChange={() => setScope("SKU")} /> Pelo SKU &quot;{g.sellerSku ?? "—"}&quot; — vale para
                  qualquer anúncio com esse SKU
                </label>
                <label style={{ display: "block" }}>
                  <input type="radio" checked={scope === "ORDER_LINE"} onChange={() => setScope("ORDER_LINE")} /> Só em uma venda (pedido #{g.sampleOrderId}) — exceção, não é
                  reaproveitado
                </label>
              </fieldset>
              {!picked && <p className="muted">Selecione um produto na busca acima para confirmar.</p>}
              {picked && (
                <p>
                  Produto escolhido: <strong>#{picked.adsProductId}</strong> · {picked.name}{" "}
                  <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => save()}>
                    {busy ? "Salvando…" : "Confirmar vínculo"}
                  </button>
                </p>
              )}
              {error && <div className="alert error">{error}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function MappingsPanel(props: { mappings: Mapping[]; unmapped: Group[]; focus: { item: string | null; sku: string | null } }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<string | null>(null);
  const done = (msg: string) => {
    setFeedback(msg);
    router.refresh();
  };
  async function deactivate(id: string) {
    if (!window.confirm("Desativar este vínculo? Pedidos já mapeados não mudam; os próximos pedidos deixam de usá-lo.")) return;
    const r = await api(`/api/mappings/${id}`, { method: "DELETE" });
    setFeedback(r.ok ? "Vínculo desativado." : errorText(r));
    router.refresh();
  }
  return (
    <>
      {feedback && (
        <div className="alert success" role="status">
          {feedback}
        </div>
      )}
      <div className="alert info">
        Para enviar um pedido à ADS, cada item precisa do <strong>código do produto na ADS</strong>. Os anúncios abaixo foram vendidos, mas o integrador não sabe a
        qual produto da ADS cada um corresponde (foram criados fora do integrador e o SKU não é o código da ADS). Vincule <strong>uma vez por anúncio</strong>:
        as vendas já recebidas e as futuras passam a usar o produto escolhido.
      </div>
      {props.unmapped.length > 0 && <BarcodeSuggestions onDone={done} />}
      <section className="card">
        <h2>Itens vendidos sem produto ADS ({props.unmapped.length})</h2>
        <p className="muted">Ordenados pelo número de vendas. Clique em Mapear, procure o produto da ADS e confirme.</p>
        {props.unmapped.length === 0 ? (
          <p className="muted">Nenhum item pendente.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Anúncio ML</th>
                  <th>Título no ML</th>
                  <th>SKU</th>
                  <th className="num">Pedidos</th>
                  <th className="num">Unidades</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.unmapped.map((g) => (
                  <GroupRow
                    key={`${g.itemId}:${g.variationId}:${g.sellerSku ?? ""}`}
                    g={g}
                    focused={g.itemId === props.focus.item || (!!props.focus.sku && g.sellerSku === props.focus.sku)}
                    onDone={done}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Vínculos ativos ({props.mappings.length})</h2>
        {props.mappings.length === 0 ? (
          <p className="muted">Nenhum vínculo cadastrado.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Chave</th>
                  <th>Produto ADS</th>
                  <th className="num">Linhas</th>
                  <th>Criado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.mappings.map((m) => (
                  <tr key={m.id}>
                    <td>{m.mappingType === "ITEM" ? "Anúncio" : "SKU"}</td>
                    <td>{m.mappingType === "ITEM" ? `${m.itemId}${m.variationId ? ` / ${m.variationId}` : ""}` : m.sellerSku}</td>
                    <td>
                      <a href={`/produtos/${m.productId}`}>
                        #{m.adsProductId} · {m.productName}
                      </a>
                    </td>
                    <td className="num">{m.usedBy}</td>
                    <td>
                      {formatDateTime(m.createdAt)} <small className="muted">{m.createdBy}</small>
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => deactivate(m.id)}>
                        Desativar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
