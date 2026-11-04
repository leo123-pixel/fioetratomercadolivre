import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { resolveUnknown } from "@/lib/publish/worker";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z
  .object({
    resolution: z.enum(["recheck", "not_created"]),
    /** Para "not_created" o administrador declara ter conferido no Mercado Livre. */
    confirm: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => v.resolution === "recheck" || v.confirm === true, "Confirme que conferiu no Mercado Livre");

/** Conciliação de resultado incerto: consulta o ML pelo SELLER_SKU. Nunca reenvia a publicação. */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const job = await resolveUnknown(getSql(), id, b.data.resolution);
    if (!job) return errorJson(409, "not_unknown", "Somente publicações com resultado desconhecido podem ser conciliadas.");
    return jsonNoStore({ job });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
