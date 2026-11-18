import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { scheduleWorker } from "@/lib/imports/scheduler";
import { createImportJob, listImportJobs, nuvemshopNeedsWorker } from "@/lib/nuvemshop/import";
import { getSql } from "@/lib/sql";
import { actorOf } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/import — histórico; retoma o worker se uma importação ficou parada. */
export const GET = adminHandler(async () => {
  const sql = getSql();
  if (await nuvemshopNeedsWorker(sql)) scheduleWorker();
  return jsonNoStore({ items: await listImportJobs(sql, 30) });
});

const Body = z.object({ mode: z.enum(["FULL", "INCREMENTAL"]).default("INCREMENTAL") });

/** POST /api/nuvemshop/import — enfileira importação do catálogo (somente leitura da Nuvemshop). */
export const POST = adminHandler(
  async (req) => {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorJson(422, "invalid_body", "Modo inválido (FULL ou INCREMENTAL)");
    const job = await createImportJob(getSql(), { mode: parsed.data.mode, actor: actorOf(req) });
    scheduleWorker();
    return jsonNoStore({ job }, 202);
  },
  { mutating: true, rateLimitPerMinute: 6 },
);
