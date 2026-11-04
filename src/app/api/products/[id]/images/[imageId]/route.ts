import { adminHandler, type RouteContext } from "@/lib/api";
import { deleteImage } from "@/lib/catalog/images";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseId } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = adminHandler(
  async (_req, ctx: RouteContext<{ id: string; imageId: string }>) => {
    const id = await parseId(ctx.params);
    const imageId = await parseId(ctx.params, "imageId");
    if (!id || !imageId) return errorJson(400, "invalid_id", "ID inválido");
    const removed = await deleteImage(getSql(), id, imageId);
    if (!removed) return errorJson(404, "not_found", "Imagem não encontrada");
    return jsonNoStore({ deleted: true });
  },
  { mutating: true },
);
