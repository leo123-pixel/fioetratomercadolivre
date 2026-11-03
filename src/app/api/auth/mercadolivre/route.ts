import { NextResponse, type NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/admin";
import { ConfigError, getEnv } from "@/lib/env";
import { redirectTo, SETTINGS_PATH } from "@/lib/http";
import { logger } from "@/lib/logger";
import { BINDING_COOKIE_PATH, bindingCookieName, startAuthorization, STATE_TTL_MS } from "@/lib/meli/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/mercadolivre — inicia o fluxo OAuth (somente administrador autenticado). */
export async function GET(req: NextRequest) {
  try {
    if (!getAdminSession(req)) {
      return redirectTo("/login", { next: SETTINGS_PATH });
    }
    // Só aceita navegação iniciada pelo próprio painel (ou digitada), nunca por outro site.
    if (req.headers.get("sec-fetch-site") === "cross-site") {
      return redirectTo(SETTINGS_PATH, { error: "forbidden" });
    }

    const { authorizationUrl, bindingNonce } = await startAuthorization();
    const res = NextResponse.redirect(authorizationUrl, 302);
    res.headers.set("Cache-Control", "no-store");
    res.cookies.set(bindingCookieName(), bindingNonce, {
      httpOnly: true,
      secure: getEnv().secureCookies,
      sameSite: "lax",
      path: BINDING_COOKIE_PATH,
      maxAge: Math.floor(STATE_TTL_MS / 1000),
    });
    return res;
  } catch (err) {
    logger.error("Falha ao iniciar OAuth do Mercado Livre", { err });
    if (err instanceof ConfigError) return NextResponse.json({ error: "config_error" }, { status: 500 });
    return redirectTo(SETTINGS_PATH, { error: "internal_error" });
  }
}
