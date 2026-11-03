import "server-only";
import { CryptoContext, decryptSecret, encryptSecret, randomToken } from "../crypto";
import { logger } from "../logger";
import { getStore } from "../store";
import type { ConnectionRecord } from "../store/types";
import { MeliApiError, refreshAccessToken } from "./client";

/** Renova com folga antes da expiração real (token do ML dura 6h). */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Duração do lease de renovação; bem maior que o timeout HTTP (15s). */
export const REFRESH_LOCK_TTL_MS = 60 * 1000;
const WAIT_INTERVAL_MS = 300;
const MAX_WAIT_MS = 20 * 1000;

/** Erros do ML que significam refresh token revogado/expirado/inválido: exige nova autorização. */
const REAUTH_ERRORS = new Set(["invalid_grant", "unauthorized_client", "unauthorized_application"]);

export type MeliAuthErrorCode = "not_connected" | "reauth_required" | "refresh_in_progress" | "refresh_failed";

export class MeliAuthError extends Error {
  constructor(
    readonly code: MeliAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeliAuthError";
  }
}

export interface ValidAccessToken {
  accessToken: string;
  meliUserId: string;
  connectionId: string;
}

export interface TokenServiceOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function hasFreshAccessToken(conn: ConnectionRecord, now: Date): boolean {
  return Boolean(conn.accessTokenEnc && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_SKEW_MS);
}

function toValid(conn: ConnectionRecord): ValidAccessToken {
  return {
    accessToken: decryptSecret(conn.accessTokenEnc!, CryptoContext.accessToken(conn.meliUserId)),
    meliUserId: conn.meliUserId,
    connectionId: conn.id,
  };
}

function assertUsable(conn: ConnectionRecord | null): ConnectionRecord {
  if (!conn || conn.status === "DISCONNECTED" || !conn.refreshTokenEnc) {
    if (conn?.status === "REAUTH_REQUIRED") throw new MeliAuthError("reauth_required", "Autorização expirada ou revogada");
    throw new MeliAuthError("not_connected", "Nenhuma conta Mercado Livre conectada");
  }
  if (conn.status === "REAUTH_REQUIRED") throw new MeliAuthError("reauth_required", "Autorização expirada ou revogada");
  return conn;
}

/**
 * Retorna um Access Token válido, renovando-o antes se estiver expirado ou perto de expirar.
 *
 * Concorrência: apenas quem obtém o lease no banco (UPDATE condicional) chama o ML; as demais
 * instâncias aguardam e relêem o token já renovado. Não há retry automático da chamada de
 * renovação: o refresh token é de uso único e reenviá-lo poderia invalidar a conexão.
 */
export async function getValidAccessToken(options: TokenServiceOptions = {}): Promise<ValidAccessToken> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + (options.maxWaitMs ?? MAX_WAIT_MS);
  const store = getStore();

  for (;;) {
    const conn = assertUsable(await store.getCurrentConnection());
    if (hasFreshAccessToken(conn, now())) return toValid(conn);

    const lockId = randomToken(16);
    const acquired = await store.tryAcquireRefreshLock(conn.id, lockId, new Date(now().getTime() + REFRESH_LOCK_TTL_MS), now());
    if (acquired) return refreshWithLock(conn.id, lockId, now);

    if (Date.now() >= deadline) {
      throw new MeliAuthError("refresh_in_progress", "Renovação do token em andamento em outra instância");
    }
    await sleep(WAIT_INTERVAL_MS);
  }
}

async function refreshWithLock(connectionId: string, lockId: string, now: () => Date): Promise<ValidAccessToken> {
  const store = getStore();
  const conn = assertUsable(await store.getConnectionById(connectionId));

  // Dupla checagem: outra instância pode ter renovado entre a leitura e a obtenção do lease.
  if (hasFreshAccessToken(conn, now())) {
    await store.releaseRefreshLock(conn.id, lockId, null);
    return toValid(conn);
  }

  const refreshToken = decryptSecret(conn.refreshTokenEnc!, CryptoContext.refreshToken(conn.meliUserId));
  let tokens;
  try {
    tokens = await refreshAccessToken(refreshToken);
  } catch (err) {
    const errorCode = err instanceof MeliApiError ? err.errorCode : "unknown_error";
    if (REAUTH_ERRORS.has(errorCode)) {
      await store.markReauthRequired(conn.id, errorCode);
      logger.warn("Refresh token inválido ou revogado; nova autorização necessária", { meliUserId: conn.meliUserId, errorCode });
      throw new MeliAuthError("reauth_required", "Autorização expirada ou revogada");
    }
    await store.releaseRefreshLock(conn.id, lockId, errorCode);
    logger.error("Falha ao renovar Access Token", { meliUserId: conn.meliUserId, errorCode });
    throw new MeliAuthError("refresh_failed", "Não foi possível renovar o Access Token");
  }

  if (String(tokens.user_id) !== conn.meliUserId) {
    await store.markReauthRequired(conn.id, "user_mismatch");
    logger.error("Renovação retornou user_id diferente da conta conectada", { meliUserId: conn.meliUserId });
    throw new MeliAuthError("reauth_required", "Conta retornada difere da conta conectada");
  }

  const refreshedAt = now();
  const persisted = await store.completeRefresh(conn.id, lockId, {
    accessTokenEnc: encryptSecret(tokens.access_token, CryptoContext.accessToken(conn.meliUserId)),
    refreshTokenEnc: encryptSecret(tokens.refresh_token, CryptoContext.refreshToken(conn.meliUserId)),
    accessTokenExpiresAt: new Date(refreshedAt.getTime() + tokens.expires_in * 1000),
    scope: tokens.scope ?? conn.scope,
    refreshedAt,
  });
  if (!persisted) {
    // Lease perdido (ex.: desconexão durante a renovação). Não reaproveita o token.
    logger.error("Lease de renovação perdido; tokens renovados descartados", { meliUserId: conn.meliUserId });
    throw new MeliAuthError("refresh_failed", "Conexão alterada durante a renovação");
  }

  logger.info("Access Token renovado", { meliUserId: conn.meliUserId });
  return { accessToken: tokens.access_token, meliUserId: conn.meliUserId, connectionId: conn.id };
}
