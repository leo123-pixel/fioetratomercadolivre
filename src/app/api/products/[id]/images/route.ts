import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { addImage, arrangeImages, ImageValidationError, listImages, RECOMMENDED_MIN_SIDE, type ProductImage } from "@/lib/catalog/images";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { MAX_IMAGE_BYTES } from "@/lib/storage/supabase";
import { parseId, parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = RouteContext<{ id: string }>;

const MAX_FILES_PER_REQUEST = 6;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 512 * 1024;

export const GET = adminHandler(async (_req, ctx: Ctx) => {
  const id = await parseId(ctx.params);
  if (!id) return errorJson(400, "invalid_id", "ID inválido");
  return jsonNoStore({ images: await listImages(getSql(), id) });
});

/**
 * Upload (multipart/form-data, campo "file", um ou mais arquivos). Cada arquivo é validado pelos
 * bytes (JPEG/PNG), tamanho e limite por produto. O painel envia um arquivo por requisição para
 * respeitar o limite de corpo da Vercel.
 */
export const POST = adminHandler(
  async (req, ctx: Ctx) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");

    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_REQUEST_BYTES) return errorJson(413, "payload_too_large", "Envie no máximo 4 MB por requisição");
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return errorJson(415, "unsupported_media_type", "Use multipart/form-data com o campo file");
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return errorJson(400, "invalid_form", "Formulário inválido");
    }
    const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (!files.length) return errorJson(400, "no_files", "Nenhum arquivo enviado no campo file");
    if (files.length > MAX_FILES_PER_REQUEST) return errorJson(400, "too_many_files", `Máximo de ${MAX_FILES_PER_REQUEST} arquivos por envio`);

    const sql = getSql();
    const uploaded: ProductImage[] = [];
    const rejected: { filename: string; code: string; message: string }[] = [];
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        rejected.push({ filename: file.name, code: "file_too_large", message: "Imagem acima de 4 MB." });
        continue;
      }
      try {
        uploaded.push(await addImage(sql, id, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name }));
      } catch (err) {
        if (err instanceof ImageValidationError) {
          if (err.code === "product_not_found") return errorJson(404, "not_found", err.message);
          rejected.push({ filename: file.name, code: err.code, message: err.message });
          continue;
        }
        throw err;
      }
    }
    const warnings = uploaded
      .filter((img) => img.width !== null && img.height !== null && Math.min(img.width, img.height) < RECOMMENDED_MIN_SIDE)
      .map((img) => ({ imageId: img.id, message: `Imagem com ${img.width}x${img.height}px; o Mercado Livre recomenda ao menos ${RECOMMENDED_MIN_SIDE}px.` }));
    const status = uploaded.length ? 201 : 422;
    return jsonNoStore({ uploaded, rejected, warnings }, status);
  },
  { mutating: true },
);

const arrangeSchema = z
  .object({
    order: z.array(z.number().int().positive()).max(50).optional(),
    primaryId: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.order !== undefined || v.primaryId !== undefined, "Informe order e/ou primaryId");

/** Reordena a galeria e/ou define a imagem principal. */
export const PATCH = adminHandler(
  async (req, ctx: Ctx) => {
    const id = await parseId(ctx.params);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const body = await parseJsonBody(req, arrangeSchema);
    if (!body.ok) return body.response;
    try {
      return jsonNoStore({ images: await arrangeImages(getSql(), id, body.data) });
    } catch (err) {
      if (err instanceof ImageValidationError) return errorJson(422, err.code, err.message);
      throw err;
    }
  },
  { mutating: true },
);
