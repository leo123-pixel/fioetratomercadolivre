import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { cancelImportJob } from "@/lib/nuvemshop/import";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/nuvemshop/import/:id/cancel — cancela a importação (o que já foi gravado permanece). */
export const POST = adminHandler<RouteContext<{ id: string }>>(
  async (_req, ctx) => {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorJson(404, "not_found", "Importação não encontrada");
    const job = await cancelImportJob(getSql(), id);
    if (!job) return errorJson(409, "not_active", "A importação não está em andamento");
    return jsonNoStore({ job });
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
