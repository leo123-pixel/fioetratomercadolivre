import type { NextRequest } from "next/server";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth/admin";
import { errorJson, isSameOrigin, jsonNoStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/logout — remove o cookie de sessão. */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return errorJson(403, "forbidden", "Origem da requisição não permitida");
  const res = jsonNoStore({ ok: true });
  res.cookies.set(sessionCookieName(), "", sessionCookieOptions(0));
  return res;
}
