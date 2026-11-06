import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { errorJson, jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { confirmLink, removeLink } from "@/lib/stock/links";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mapBody = z.object({
  productId: z.number().int().positive(),
  /** Composição de kit/pacote: produtos e quantidade de cada um por venda. */
  components: z
    .array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(1).max(1000) }))
    .max(20)
    .optional(),
  maxQuantity: z.number().int().min(0).max(1_000_000).nullish(),
  notes: z.string().max(300).nullish(),
  replace: z.boolean().optional(),
  /** Confirmação explícita do operador. */
  confirm: z.literal(true),
});

/** Confirma o vínculo do anúncio (ou variação) com o produto ADS. Nunca automático. */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const b = await parseJsonBody(req, mapBody);
    if (!b.ok) return b.response;
    const r = await confirmLink(getSql(), id, b.data, requesterFromSession(getAdminSession(req)?.sid));
    return jsonNoStore(r, 201);
  },
  { mutating: true, rateLimitPerMinute: 120 },
);

const deleteBody = z.object({ confirm: z.literal(true) });

/** Remove o vínculo (exige confirmação). Propostas abertas desse anúncio deixam de valer. */
export const DELETE = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const b = await parseJsonBody(req, deleteBody);
    if (!b.ok) return b.response;
    if (!(await removeLink(getSql(), id, requesterFromSession(getAdminSession(req)?.sid)))) return errorJson(404, "not_found", "Vínculo não encontrado");
    return jsonNoStore({ ok: true });
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
