import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";

/** Contextos (AAD) que amarram cada ciphertext ao seu propósito: um valor não pode ser trocado por outro. */
export const CryptoContext = {
  accessToken: (meliUserId: string) => `meli:access_token:${meliUserId}`,
  refreshToken: (meliUserId: string) => `meli:refresh_token:${meliUserId}`,
  pkceVerifier: "meli:pkce_verifier",
} as const;

function encryptionKey(): Buffer {
  return Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, "base64");
}

/** AES-256-GCM. Formato: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, context: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Formato de segredo criptografado inválido");
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE (RFC 7636): verifier de 86 caracteres e challenge S256. */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomToken(64);
  return { codeVerifier, codeChallenge: pkceChallengeS256(codeVerifier) };
}

export function pkceChallengeS256(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
