import "server-only";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { NextRequest } from "next/server";
import { getEnv } from "../env";
import { safeEqual } from "../crypto";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface AdminSession {
  sid: string;
  iat: number;
  exp: number;
}

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Formato: scrypt$N$r$p$salt$hash (base64url). Mesmo formato de scripts/hash-admin-password.mjs. */
export async function hashPassword(password: string, N = 16384, r = 8, p = 1): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sessionCookieName(): string {
  return getEnv().secureCookies ? "__Host-ft_admin" : "ft_admin";
}

function sign(payload: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(payload).digest("base64url");
}

export function createSessionToken(nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const session: AdminSession = { sid: randomBytes(16).toString("base64url"), iat, exp: iat + SESSION_TTL_SECONDS };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null, nowMs = Date.now()): AdminSession | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AdminSession;
    if (typeof session.exp !== "number" || session.exp * 1000 <= nowMs) return null;
    return session;
  } catch {
    return null;
  }
}

export function getAdminSession(req: NextRequest): AdminSession | null {
  return verifySessionToken(req.cookies.get(sessionCookieName())?.value);
}

/**
 * SameSite=Lax é necessário: o retorno do Mercado Livre para o callback é uma navegação
 * top-level vinda de outro site e precisa carregar a sessão do administrador.
 */
export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: getEnv().secureCookies,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
