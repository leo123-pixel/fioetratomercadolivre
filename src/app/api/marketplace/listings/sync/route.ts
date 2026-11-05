import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { runSyncJob } from "@/lib/marketplace/scheduler";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Executa agora a reconciliação de leitura dos anúncios (a mesma rotina periódica do agendador).
 * Lê status, preço e quantidade no Mercado Livre; não altera nada no ML.
 */
export const POST = adminHandler(
  async () => {
    const job = await runSyncJob(getSql(), "LISTINGS_RECONCILE", "manual");
    if (job.status === "BUSY") return jsonNoStore({ error: "busy", message: "Uma reconciliação já está em andamento. Aguarde alguns segundos." }, 409);
    return jsonNoStore({ ...job.details, jobId: job.id, status: job.status, checked: job.processed, changed: job.changed, failed: job.failed, error: job.error ?? null });
  },
  { mutating: true, rateLimitPerMinute: 6 },
);
