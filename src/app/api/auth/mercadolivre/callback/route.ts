import { NextResponse, type NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/admin";
import { ConfigError, getEnv } from "@/lib/env";
import { redirectTo, SETTINGS_PATH } from "@/lib/http";
import { logger } from "@/lib/logger";
import { BINDING_COOKIE_PATH, bindingCookieName, handleCallback } from "@/lib/meli/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function finish(params: Record<string, string>): NextResponse {
  const res = redirectTo(SETTINGS_PATH, params);
  // O code está na URL atual: não vazar via Referer e descartar o binding (uso único).
  res.headers.set("Referrer-Policy", "no-referrer");
  res.cookies.set(bindingCookieName(), "", {
    httpOnly: true,
    secure: getEnv().secureCookies,
    sameSite: "lax",
    path: BINDING_COOKIE_PATH,
    maxAge: 0,
  });
  return res;
}

/**
 * GET /api/auth/mercadolivre/callback — retorno do Mercado Livre.
 * Só processa o code se houver sessão de administrador E state válido amarrado a este navegador.
 * Nenhuma outra ação administrativa é executada aqui.
 */
export async function GET(req: NextRequest) {
  try {
    if (!getAdminSession(req)) {
      logger.warn("Callback OAuth recebido sem sessão de administrador");
      return finish({ error: "unauthorized" });
    }

    const params = req.nextUrl.searchParams;
    const result = await handleCallback({
      code: params.get("code"),
      state: params.get("state"),
      error: params.get("error"),
      bindingNonce: req.cookies.get(bindingCookieName())?.value ?? null,
    });
    return finish(result.ok ? { status: "connected" } : { error: result.error });
  } catch (err) {
    logger.error("Erro inesperado no callback OAuth", { err });
    if (err instanceof ConfigError) return NextResponse.json({ error: "config_error" }, { status: 500 });
    return finish({ error: "internal_error" });
  }
}
