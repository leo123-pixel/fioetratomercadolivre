import { adminHandler, type RouteContext } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { cancelJob } from "@/lib/imports/jobs";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancela uma tarefa ativa. Páginas já gravadas permanecem (são consistentes por si só). */
export const POST = adminHandler(
  async (_req, ctx: RouteContext<{ id: string }>) => {
    const { id } = await ctx.params;
    const job = await cancelJob(getSql(), id);
    if (!job) return errorJson(409, "not_active", "A importação não está em andamento");
    return jsonNoStore({ job });
  },
  { mutating: true },
);
