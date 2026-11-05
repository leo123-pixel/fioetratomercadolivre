import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { errorJson, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { scheduleTick, verifySchedulerToken, type Trigger } from "@/lib/marketplace/scheduler";

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
 * Tick do agendador (pg_cron do Supabase a cada 5 min; Vercel Cron diário). Não é rota de administrador:
 * exige o token interno (x-scheduler-token, derivado de SESSION_SECRET) ou CRON_SECRET.
 * Responde 202 e processa depois da resposta; a execução é idempotente e protegida por leases.
 */
async function handle(req: NextRequest) {
  let trigger: Trigger;
  try {
    if (verifySchedulerToken(req.headers.get("x-scheduler-token"))) trigger = "scheduler";
    else if (cronAuthorized(req)) trigger = "cron";
    else return errorJson(401, "unauthorized", "Não autorizado");
  } catch (err) {
    logger.error("Agendador sem configuração válida", { err });
    return errorJson(500, "config_error", "Configuração do servidor incompleta");
  }
  scheduleTick(trigger);
  return jsonNoStore({ accepted: true }, 202);
}

export const POST = handle;
export const GET = handle;
