import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { errorJson, jsonNoStore } from "@/lib/http";
import { scheduleWorker, verifyWorkerToken } from "@/lib/imports/scheduler";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const header = req.headers.get("authorization");
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Ponto de entrada interno do worker (encadeamento de fatias e Vercel Cron).
 * Não é uma rota de administrador: exige o token interno ou CRON_SECRET. Responde imediatamente
 * e processa após a resposta.
 */
async function handle(req: NextRequest) {
  try {
    if (!verifyWorkerToken(req.headers.get("x-worker-token")) && !cronAuthorized(req)) {
      return errorJson(401, "unauthorized", "Não autorizado");
    }
  } catch (err) {
    logger.error("Worker sem configuração válida", { err });
    return errorJson(500, "config_error", "Configuração do servidor incompleta");
  }
  scheduleWorker();
  return jsonNoStore({ accepted: true }, 202);
}

export const POST = handle;
export const GET = handle;
