import { NextResponse, type NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/admin";
import { ConfigError, getEnv } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { logger } from "@/lib/logger";
import { BINDING_COOKIE_PATH, bindingCookieName, handleCallback } from "@/lib/nuvemshop/oauth";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PANEL = "/nuvemshop";

function finish(params: Record<string, string>): NextResponse {
  const res = redirectTo(PANEL, params);
  // O code está na URL atual: não vazar via Referer e descartar o binding (uso único).
  res.headers.set("Referrer-Policy", "no-referrer");
  res.cookies.set(bindingCookieName(), "", { httpOnly: true, secure: getEnv().secureCookies, sameSite: "lax", path: BINDING_COOKIE_PATH, maxAge: 0 });
  return res;
}

/**
 * GET /api/auth/nuvemshop/callback — retorno da Nuvemshop (URL de redirecionamento do aplicativo).
 * Só processa o code com sessão de administrador e state válido amarrado a este navegador.
 */
export async function GET(req: NextRequest) {
  try {
    const session = getAdminSession(req);
    if (!session) {
      logger.warn("Callback OAuth Nuvemshop recebido sem sessão de administrador");
      return finish({ error: "unauthorized" });
    }
    const p = req.nextUrl.searchParams;
    const result = await handleCallback(getSql(), {
      code: p.get("code"),
      state: p.get("state"),
      error: p.get("error"),
      bindingNonce: req.cookies.get(bindingCookieName())?.value ?? null,
      actor: requesterFromSession(session.sid),
    });
    if (result.ok) return finish({ status: result.reinstalled ? "reconnected" : "connected" });
    return finish(result.detail ? { error: result.error, detail: result.detail.slice(0, 120) } : { error: result.error });
  } catch (err) {
    logger.error("Erro inesperado no callback OAuth da Nuvemshop", { err });
    if (err instanceof ConfigError) return finish({ error: "config_error" });
    return finish({ error: "internal_error" });
  }
}
