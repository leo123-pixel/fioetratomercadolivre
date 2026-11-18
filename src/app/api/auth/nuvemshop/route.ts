import { NextResponse, type NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/admin";
import { ConfigError, getEnv } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { logger } from "@/lib/logger";
import { BINDING_COOKIE_PATH, bindingCookieName, startAuthorization, STATE_TTL_MS } from "@/lib/nuvemshop/oauth";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PANEL = "/nuvemshop";

/** GET /api/auth/nuvemshop — inicia a instalação/autorização do aplicativo (somente administrador). */
export async function GET(req: NextRequest) {
  try {
    const session = getAdminSession(req);
    if (!session) return redirectTo("/login", { next: PANEL });
    if (req.headers.get("sec-fetch-site") === "cross-site") return redirectTo(PANEL, { error: "forbidden" });
    const { authorizationUrl, bindingNonce } = await startAuthorization(getSql(), requesterFromSession(session.sid));
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
    logger.error("Falha ao iniciar OAuth da Nuvemshop", { err });
    if (err instanceof ConfigError) return redirectTo(PANEL, { error: "config_error" });
    return redirectTo(PANEL, { error: "internal_error" });
  }
}
