import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "./env";

export const SETTINGS_PATH = "/configuracoes/integracoes/mercadolivre";

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorJson(status: number, error: string, message: string): NextResponse {
  return jsonNoStore({ error, message }, status);
}

/** Redirect absoluto sempre para a origem configurada (nunca para hosts vindos da requisição). */
export function redirectTo(path: string, params?: Record<string, string>): NextResponse {
  const url = new URL(path, getEnv().APP_BASE_URL);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * Proteção CSRF para métodos que alteram estado: exige Origin igual ao APP_BASE_URL
 * (ou, na ausência de Origin, Sec-Fetch-Site: same-origin).
 */
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === getEnv().appOrigin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}
