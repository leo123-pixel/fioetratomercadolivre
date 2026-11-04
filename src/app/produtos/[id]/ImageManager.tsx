"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, errorText } from "@/lib/client-api";

export interface ImageView {
  id: number;
  publicUrl: string;
  width: number | null;
  height: number | null;
  isPrimary: boolean;
  originalFilename: string | null;
  sizeBytes: number;
}

const ACCEPT = "image/jpeg,image/png";
const MAX_BYTES = 4 * 1024 * 1024;

export function ImageManager({ productId, initial, recommendedMinSide }: { productId: number; initial: ImageView[]; recommendedMinSide: number }) {
  const router = useRouter();
  const [images, setImages] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [messages, setMessages] = useState<{ kind: "success" | "error" | "warn"; text: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    const out: typeof messages = [];
    try {
      // Um arquivo por requisição (limite de corpo da Vercel).
      for (const file of list) {
        if (file.size > MAX_BYTES) {
          out.push({ kind: "error", text: `${file.name}: acima de 4 MB.` });
          continue;
        }
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ uploaded: ImageView[]; rejected: { message: string }[]; warnings: { message: string }[] }>(`/api/products/${productId}/images`, { form });
        if (r.ok) {
          setImages((prev) => [...prev, ...r.data.uploaded]);
          out.push({ kind: "success", text: `${file.name}: enviada.` });
          for (const w of r.data.warnings ?? []) out.push({ kind: "warn", text: `${file.name}: ${w.message}` });
        } else if (r.data.rejected?.length) {
          out.push({ kind: "error", text: `${file.name}: ${r.data.rejected[0].message}` });
        } else {
          out.push({ kind: "error", text: `${file.name}: ${errorText(r)}` });
        }
      }
    } finally {
      setMessages(out);
      setBusy(false);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }

  async function arrange(body: { order?: number[]; primaryId?: number }) {
    setBusy(true);
    try {
      const r = await api<{ images: ImageView[] }>(`/api/products/${productId}/images`, { method: "PATCH", body });
      if (r.ok) setImages(r.data.images);
      else setMessages([{ kind: "error", text: errorText(r) }]);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  function move(index: number, delta: number) {
    const order = images.map((i) => i.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    void arrange({ order });
  }

  async function remove(image: ImageView) {
    if (!window.confirm("Excluir esta imagem? O arquivo também será removido do armazenamento.")) return;
    setBusy(true);
    try {
      const r = await api(`/api/products/${productId}/images/${image.id}`, { method: "DELETE" });
      if (!r.ok) return setMessages([{ kind: "error", text: errorText(r) }]);
      const rest = images.filter((i) => i.id !== image.id);
      if (image.isPrimary && rest.length) rest[0] = { ...rest[0], isPrimary: true };
      setImages(rest);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <section className="card" aria-labelledby="imagens">
      <div className="status-row">
        <h2 id="imagens">Imagens ({images.length})</h2>
        <span className="muted">JPEG ou PNG, até 4 MB, recomendado ≥ {recommendedMinSide}px</span>
      </div>
      <div
        className={`dropzone${drag ? " active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload(e.dataTransfer.files);
        }}
      >
        <p style={{ margin: "0 0 8px" }}>Arraste imagens aqui ou</p>
        <label className="btn btn-primary" style={{ display: "inline-flex", marginBottom: 0 }}>
          {busy ? "Enviando…" : "Selecionar arquivos"}
          <input ref={input} type="file" accept={ACCEPT} multiple hidden disabled={busy} onChange={(e) => e.target.files && void upload(e.target.files)} />
        </label>
      </div>
      {messages.map((m, i) => (
        <div key={i} className={`alert ${m.kind}`} style={{ margin: "8px 0 0" }}>
          {m.text}
        </div>
      ))}
      {images.length === 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>
          Nenhuma imagem. Produtos sem imagem podem ficar no catálogo, mas não podem ser marcados como prontos para publicação.
        </p>
      ) : (
        <div className="gallery" style={{ marginTop: 12 }}>
          {images.map((img, idx) => (
            <figure key={img.id} className={img.isPrimary ? "primary" : undefined}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.publicUrl} alt={img.originalFilename ?? `Imagem ${idx + 1}`} loading="lazy" />
              <figcaption>
                {img.isPrimary ? (
                  <span className="chip info">Principal</span>
                ) : (
                  <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => arrange({ primaryId: img.id })}>
                    Tornar principal
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" type="button" disabled={busy || idx === 0} onClick={() => move(idx, -1)} aria-label="Mover para a esquerda">
                  ←
                </button>
                <button className="btn btn-secondary btn-sm" type="button" disabled={busy || idx === images.length - 1} onClick={() => move(idx, 1)} aria-label="Mover para a direita">
                  →
                </button>
                <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => remove(img)}>
                  Excluir
                </button>
                {img.width && img.height ? (
                  <span className={Math.min(img.width, img.height) < recommendedMinSide ? "hint warn" : "hint"} style={{ width: "100%" }}>
                    {img.width}×{img.height}px
                  </span>
                ) : null}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
