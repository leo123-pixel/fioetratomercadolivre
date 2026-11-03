import { CryptoContext, encryptSecret } from "@/lib/crypto";
import { memoryStore } from "./memory-store";

/** Cria uma conexão ativa com tokens criptografados, expirando em `expiresInMs`. */
export async function seedConnection(opts: { expiresInMs: number; accessToken?: string; refreshToken?: string; meliUserId?: string }) {
  const meliUserId = opts.meliUserId ?? "42";
  return memoryStore().saveAuthorizedConnection({
    meliUserId,
    nickname: "FIOETRATO",
    siteId: "MLB",
    accessTokenEnc: encryptSecret(opts.accessToken ?? "APP_USR-OLD-ACCESS-42", CryptoContext.accessToken(meliUserId)),
    refreshTokenEnc: encryptSecret(opts.refreshToken ?? "TG-OLD-REFRESH-42", CryptoContext.refreshToken(meliUserId)),
    accessTokenExpiresAt: new Date(Date.now() + opts.expiresInMs),
    scope: "offline_access read write",
    connectedAt: new Date(),
  });
}
