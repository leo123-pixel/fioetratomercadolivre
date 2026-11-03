import "server-only";
import { cookies } from "next/headers";
import { sessionCookieName, verifySessionToken, type AdminSession } from "./admin";

/** Sessão do administrador em Server Components. */
export async function getServerAdminSession(): Promise<AdminSession | null> {
  const store = await cookies();
  return verifySessionToken(store.get(sessionCookieName())?.value);
}

/** Aceita apenas caminhos relativos internos para evitar open redirect. */
export function safeNextPath(next: string | undefined, fallback: string): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : fallback;
}
