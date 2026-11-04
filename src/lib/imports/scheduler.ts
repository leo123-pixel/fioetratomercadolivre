import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { getEnv } from "../env";
import { logger } from "../logger";
import { processJobs } from "./worker";

/**
 * Agendamento do worker sem fila externa (Redis/BullMQ não existem neste projeto):
 *
 * 1. Quem cria uma tarefa chama scheduleWorker(); a fatia roda via `after()` depois da resposta HTTP.
 * 2. Cada fatia trabalha até ~45 s e, se ainda houver trabalho, invoca POST /api/import/worker
 *    (nova função serverless, novo limite de tempo) autenticada por um token derivado de SESSION_SECRET.
 * 3. Se uma invocação morrer (timeout, deploy, restart), o lease expira e a próxima consulta de
 *    progresso do painel (GET /api/import/jobs) reagenda o worker, que retoma do cursor salvo.
 */
export const WORKER_PATH = "/api/import/worker";
export const SLICE_BUDGET_MS = 45_000;

export function workerToken(): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update("ads-import-worker:v1").digest("base64url");
}

export function verifyWorkerToken(candidate: string | null): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(workerToken());
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function triggerNextSlice(): Promise<void> {
  try {
    const res = await fetch(new URL(WORKER_PATH, getEnv().APP_BASE_URL), {
      method: "POST",
      headers: { "x-worker-token": workerToken() },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) logger.warn("Falha ao encadear o worker de importação", { status: res.status });
  } catch (err) {
    logger.warn("Falha ao encadear o worker de importação", { err });
  }
}

/** Uma fatia processa as duas filas em paralelo (importação ADS e publicação ML), cada uma com seu lease. */
export async function runSliceAndChain(): Promise<void> {
  try {
    const { processPublicationJobs } = await import("../publish/worker");
    const [imports, publish] = await Promise.all([
      processJobs({ budgetMs: SLICE_BUDGET_MS }).catch((err) => {
        logger.error("Erro no worker de importação", { err });
        return { more: false };
      }),
      processPublicationJobs({ budgetMs: SLICE_BUDGET_MS }).catch((err) => {
        logger.error("Erro no worker de publicação", { err });
        return { more: false };
      }),
    ]);
    if (imports.more || publish.more) await triggerNextSlice();
  } catch (err) {
    logger.error("Erro no worker", { err });
  }
}

type Scheduler = () => void;

let scheduler: Scheduler = () => after(runSliceAndChain);

/** Agenda uma fatia do worker para depois da resposta atual. */
export function scheduleWorker(): void {
  scheduler();
}

/** Somente para testes: substitui o agendamento (ex.: no-op ou execução síncrona). */
export function setSchedulerForTesting(fn: Scheduler | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setSchedulerForTesting só pode ser usado em testes");
  scheduler = fn ?? (() => after(runSliceAndChain));
}
