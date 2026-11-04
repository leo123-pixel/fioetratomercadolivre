import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { cancelPublicationJob } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancela somente jobs que ainda não enviaram nada ao Mercado Livre. */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const job = await cancelPublicationJob(getSql(), id);
    if (!job) return errorJson(409, "not_cancelable", "Só é possível cancelar publicações ainda na fila (nada enviado ao Mercado Livre).");
    return jsonNoStore({ job });
  },
  { mutating: true },
);
