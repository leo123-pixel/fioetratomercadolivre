import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import {
  addImage,
  addImageSchema,
  createVariant,
  createVariantSchema,
  productEditorView,
  reconcileUncertainCreate,
  removeImage,
  setMainImage,
  setVisibility,
  updateProduct,
  updateProductSchema,
  updateVariant,
  updateVariantSchema,
  VISIBILITY,
} from "@/lib/nuvemshop/products-admin";
import { getSql } from "@/lib/sql";
import { actorOf, catalogStoreId } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Id = z.string().regex(/^\d{1,20}$/);

/** GET /api/nuvemshop/catalog/:productId — dados do editor (produto, variantes, imagens, operações). */
export const GET = adminHandler<RouteContext<{ productId: string }>>(async (_req, ctx) => {
  const { productId } = await ctx.params;
  if (!Id.safeParse(productId).success) return errorJson(422, "invalid_id", "ID inválido");
  const sql = getSql();
  const view = await productEditorView(sql, await catalogStoreId(sql), productId);
  return view ? jsonNoStore(view) : errorJson(404, "not_found", "Produto não encontrado no catálogo importado");
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), patch: updateProductSchema }),
  z.object({ action: z.literal("visibility"), visibility: z.enum(VISIBILITY), confirm: z.boolean().optional() }),
  z.object({ action: z.literal("create_variant"), variant: createVariantSchema }),
  z.object({ action: z.literal("update_variant"), variantId: Id, patch: updateVariantSchema }),
  z.object({ action: z.literal("add_image"), image: addImageSchema }),
  z.object({ action: z.literal("set_main_image"), imageId: Id }),
  z.object({ action: z.literal("remove_image"), imageId: Id, confirmImageId: Id.nullish() }),
  z.object({ action: z.literal("reconcile_create"), operationId: z.string().uuid() }),
]);

/** POST /api/nuvemshop/catalog/:productId — edição manual (cada escrita é relida e auditada). */
export const POST = adminHandler<RouteContext<{ productId: string }>>(
  async (req, ctx) => {
    const { productId } = await ctx.params;
    if (!Id.safeParse(productId).success) return errorJson(422, "invalid_id", "ID inválido");
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonNoStore({ error: "invalid_body", message: "Requisição inválida", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 422);
    const sql = getSql();
    const actor = actorOf(req);
    const b = parsed.data;
    switch (b.action) {
      case "update":
        return jsonNoStore(await updateProduct(sql, productId, b.patch, actor));
      case "visibility":
        return jsonNoStore(await setVisibility(sql, productId, b.visibility, b.confirm === true, actor));
      case "create_variant":
        return jsonNoStore(await createVariant(sql, productId, b.variant, actor), 201);
      case "update_variant":
        return jsonNoStore(await updateVariant(sql, productId, b.variantId, b.patch, actor));
      case "add_image":
        return jsonNoStore(await addImage(sql, productId, b.image, actor), 201);
      case "set_main_image":
        return jsonNoStore(await setMainImage(sql, productId, b.imageId, actor));
      case "remove_image":
        return jsonNoStore(await removeImage(sql, productId, b.imageId, b.confirmImageId ?? null, actor));
      case "reconcile_create":
        return jsonNoStore(await reconcileUncertainCreate(sql, b.operationId, actor));
      default:
        return errorJson(422, "invalid_action", "Ação inválida");
    }
  },
  { mutating: true, rateLimitPerMinute: 40 },
);
