"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

interface View {
  product: { productId: string; name: string | null; description: string | null; brand: string | null; visibility: string | null; categoryIds: string[]; canonicalUrl: string | null; syncStatus: string; fetchedAt: string };
  variants: { variantId: string; sku: string | null; barcode: string | null; price: string | null; promotionalPrice: string | null; stockManagement: boolean | null; stock: number | null; visible: boolean | null; syncStatus: string; mappingStatus: string | null; adsProductId: number | null; adsName: string | null }[];
  images: { imageId: string; src: string; position: number | null }[];
  categories: { id: string; name: string | null }[];
  operations: { id: string; operation: string; status: string; verified: boolean; errorMessage: string | null; actor: string; createdAt: string }[];
}

const VIS: Record<string, string> = { visible: "Publicado (visível)", unlisted: "Não listado (só por link)", hidden: "Oculto" };

export function ProductEditor({ productId, view }: { productId: string; view: View }) {
  const router = useRouter();
  const p = view.product;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [name, setName] = useState(p.name ?? "");
  const [brand, setBrand] = useState(p.brand ?? "");
  const [description, setDescription] = useState(p.description ?? "");
  const [cats, setCats] = useState<string[]>(p.categoryIds ?? []);
  const [imageUrl, setImageUrl] = useState("");
  const [nv, setNv] = useState({ values: "", price: "", sku: "", productId: "" });

  async function send(body: Record<string, unknown>, ok: (d: Record<string, unknown>) => string) {
    setBusy(true);
    setMsg(null);
    const r = await api<Record<string, unknown>>(`/api/nuvemshop/catalog/${productId}`, { method: "POST", body });
    setBusy(false);
    setMsg(r.ok ? { kind: "success", text: ok(r.data) } : { kind: "error", text: errorText(r) });
    if (r.ok) router.refresh();
  }
  const verified = (d: Record<string, unknown>) => (d.verified ? "confirmado na releitura da loja" : "enviado, mas a releitura ainda não confirmou — confira na Nuvemshop");

  return (
    <>
      {msg && (
        <div className={`alert ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      {p.syncStatus !== "ACTIVE" && <div className="alert warn">Produto removido na Nuvemshop: edição indisponível.</div>}
      <section className="card">
        <div className="status-row">
          <h2 style={{ margin: 0 }}>Dados do produto</h2>
          <span className={`chip ${p.visibility === "visible" ? "ok" : "warn"}`}>{VIS[p.visibility ?? ""] ?? p.visibility ?? "—"}</span>
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <label>
            Nome
            <input value={name} maxLength={250} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Marca
            <input value={brand} maxLength={120} onChange={(e) => setBrand(e.target.value)} />
          </label>
          <label>
            Descrição (HTML permitido pela Nuvemshop)
            <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>
            Categorias
            <select multiple value={cats} onChange={(e) => setCats([...e.target.selectedOptions].map((o) => o.value))} style={{ minHeight: 90 }}>
              {view.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            disabled={busy || p.syncStatus !== "ACTIVE"}
            onClick={() =>
              send({ action: "update", patch: { name, brand: brand || null, description: description || null, ...(cats.length ? { categoryIds: cats.map(Number) } : {}) } }, (d) => `Produto salvo: ${verified(d)}.`)
            }
          >
            Salvar dados
          </button>
          {p.visibility !== "visible" ? (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Publicar o produto na loja (fica visível e comprável)?")) send({ action: "visibility", visibility: "visible", confirm: true }, (d) => `Publicado: ${verified(d)}.`);
              }}
            >
              Publicar
            </button>
          ) : (
            <button className="btn btn-secondary" disabled={busy} onClick={() => send({ action: "visibility", visibility: "hidden" }, (d) => `Ocultado: ${verified(d)}.`)}>
              Ocultar
            </button>
          )}
          {p.canonicalUrl && (
            <a href={p.canonicalUrl} target="_blank" rel="noreferrer noopener" className="muted">
              ver na loja
            </a>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Variantes</h2>
        <p className="hint">O estoque não é editado aqui: vem só da sincronização (cota do Inventory Core). O preço de variante sob automação de preço também não.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Variante</th>
                <th>SKU</th>
                <th>Preço</th>
                <th>Estoque</th>
                <th>Vínculo ADS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.variants.map((v) => (
                <tr key={v.variantId}>
                  <td>
                    {v.variantId} {v.syncStatus !== "ACTIVE" && <span className="chip danger">removida</span>}
                  </td>
                  <td>{v.sku ?? <span className="chip warn">sem SKU</span>}</td>
                  <td>
                    {v.price ?? "—"}
                    {v.promotionalPrice && <small className="muted"> promo {v.promotionalPrice}</small>}
                  </td>
                  <td>{v.stockManagement === false ? "ilimitado" : (v.stock ?? "—")}</td>
                  <td>
                    {v.adsProductId ? (
                      <>
                        #{v.adsProductId} <small className="muted">{v.adsName}</small> {v.mappingStatus === "NEEDS_REVIEW" && <span className="chip warn">revisar</span>}
                      </>
                    ) : (
                      <a href={`/nuvemshop/produtos/vinculacao?q=${v.variantId}`}>vincular</a>
                    )}
                  </td>
                  <td>
                    {v.syncStatus === "ACTIVE" && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => {
                          const price = window.prompt(`Novo preço da variante ${v.variantId} (R$):`, v.price ?? "");
                          if (price && Number(price.replace(",", ".")) > 0) send({ action: "update_variant", variantId: v.variantId, patch: { price: Number(price.replace(",", ".")) } }, (d) => `Variante salva: ${verified(d)}.`);
                        }}
                      >
                        Preço
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Nova variante</h3>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>
          <input placeholder="Opção (ex.: 500 ml)" value={nv.values} onChange={(e) => setNv({ ...nv, values: e.target.value })} aria-label="Opção" />
          <input placeholder="Preço" value={nv.price} onChange={(e) => setNv({ ...nv, price: e.target.value })} aria-label="Preço" style={{ maxWidth: 110 }} />
          <input placeholder="SKU (ex.: ADS-123)" value={nv.sku} onChange={(e) => setNv({ ...nv, sku: e.target.value })} aria-label="SKU" />
          <input placeholder="ID interno do produto ADS (opcional)" value={nv.productId} onChange={(e) => setNv({ ...nv, productId: e.target.value })} aria-label="Produto ADS" />
          <button
            className="btn btn-secondary"
            disabled={busy || !nv.values || !nv.sku || !(Number(nv.price.replace(",", ".")) > 0)}
            onClick={() =>
              send(
                { action: "create_variant", variant: { values: nv.values.split("/").map((x) => x.trim()).filter(Boolean), price: Number(nv.price.replace(",", ".")), sku: nv.sku, ...(nv.productId ? { productId: Number(nv.productId) } : {}) } },
                (d) => `Variante ${d.variantId} criada com estoque 0${d.linked ? " e vinculada" : ""}.`,
              )
            }
          >
            Criar variante
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Imagens</h2>
        <p className="hint">A imagem na posição 1 é a principal. Remover pede confirmação com o ID da imagem.</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {view.images.map((i) => (
            <figure key={i.imageId} style={{ margin: 0, width: 150 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={i.src} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: 150, height: 150, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
              <figcaption>
                <small>
                  #{i.position ?? "?"} {i.position === 1 && <span className="chip ok">principal</span>}
                </small>
                <div className="toolbar">
                  {i.position !== 1 && (
                    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => send({ action: "set_main_image", imageId: i.imageId }, (d) => `Imagem principal definida: ${verified(d)}.`)}>
                      Principal
                    </button>
                  )}
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => {
                      const typed = window.prompt(`Remover a imagem da loja? Digite o ID ${i.imageId} para confirmar:`);
                      if (typed === i.imageId) send({ action: "remove_image", imageId: i.imageId, confirmImageId: typed }, (d) => `Imagem removida: ${verified(d)}.`);
                    }}
                  >
                    Remover
                  </button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <input type="url" placeholder="https://… (URL pública da imagem)" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} aria-label="URL da imagem" style={{ minWidth: 320 }} />
          <button className="btn btn-secondary" disabled={busy || !imageUrl.startsWith("https://")} onClick={() => send({ action: "add_image", image: { src: imageUrl } }, (d) => `Imagem adicionada: ${verified(d)}.`)}>
            Adicionar imagem
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Histórico de alterações</h2>
        {!view.operations.length ? (
          <div className="empty-state">Nenhuma alteração feita pelo integrador.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {view.operations.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <small>{formatDateTime(o.createdAt)}</small>
                    </td>
                    <td>{o.operation}</td>
                    <td>
                      <span className={`chip ${o.status === "SUCCEEDED" || o.status === "RESOLVED" ? "ok" : o.status === "UNCERTAIN" ? "warn" : "danger"}`}>{o.status}</span> {o.verified && <small className="muted">conferido</small>}
                    </td>
                    <td>
                      <small>{o.errorMessage}</small>
                    </td>
                    <td>
                      <small className="muted">{o.actor}</small>
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
