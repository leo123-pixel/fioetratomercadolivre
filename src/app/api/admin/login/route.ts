import type { NextRequest } from "next/server";
import { createSessionToken, sessionCookieName, sessionCookieOptions, verifyPassword } from "@/lib/auth/admin";
import { sha256Hex } from "@/lib/crypto";
import { ConfigError, getEnv } from "@/lib/env";
import { errorJson, isSameOrigin, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function clientKey(req: NextRequest): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return sha256Hex(`login:${ip}`);
}

/** POST /api/admin/login — body: { "password": "..." }. Define o cookie de sessão HttpOnly. */
export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req)) return errorJson(403, "forbidden", "Origem da requisição não permitida");

    const store = getStore();
    const key = clientKey(req);
    const now = new Date();
    if (await store.getLoginLockedUntil(key, now)) {
      return errorJson(429, "too_many_attempts", "Muitas tentativas. Aguarde alguns minutos.");
    }

    const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : "";
    const valid = password.length > 0 && password.length <= 256 && (await verifyPassword(password, getEnv().ADMIN_PASSWORD_HASH));
    if (!valid) {
      await store.recordLoginFailure(key, now, MAX_FAILURES, LOCK_MS);
      logger.warn("Tentativa de login de administrador inválida");
      return errorJson(401, "invalid_credentials", "Senha inválida");
    }

    await store.clearLoginFailures(key);
    const res = jsonNoStore({ ok: true });
    res.cookies.set(sessionCookieName(), createSessionToken(), sessionCookieOptions());
    return res;
  } catch (err) {
    logger.error("Erro no login de administrador", { err });
    if (err instanceof ConfigError) return errorJson(500, "config_error", "Configuração do servidor incompleta");
    return errorJson(500, "internal_error", "Erro interno");
  }
}
