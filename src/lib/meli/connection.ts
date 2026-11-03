import "server-only";
import { logger } from "../logger";
import { getStore } from "../store";
import { getUserMe, MeliApiError, revokeUserGrant } from "./client";
import { getValidAccessToken, MeliAuthError } from "./tokens";

export type ConnectionState = "connected" | "disconnected" | "reauth_required";

/** Somente dados não sensíveis: nunca inclui tokens, nem cifrados. */
export interface ConnectionSummary {
  status: ConnectionState;
  meliUserId: string | null;
  nickname: string | null;
  siteId: string | null;
  accessTokenExpiresAt: string | null;
  lastConnectedAt: string | null;
  lastRefreshedAt: string | null;
  lastErrorCode: string | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export async function getConnectionSummary(): Promise<ConnectionSummary> {
  const conn = await getStore().getCurrentConnection();
  if (!conn) {
    return {
      status: "disconnected",
      meliUserId: null,
      nickname: null,
      siteId: null,
      accessTokenExpiresAt: null,
      lastConnectedAt: null,
      lastRefreshedAt: null,
      lastErrorCode: null,
    };
  }
  const status: ConnectionState =
    conn.status === "ACTIVE" && conn.refreshTokenEnc ? "connected" : conn.status === "REAUTH_REQUIRED" ? "reauth_required" : "disconnected";
  return {
    status,
    meliUserId: conn.meliUserId,
    nickname: conn.nickname,
    siteId: conn.siteId,
    accessTokenExpiresAt: status === "connected" ? iso(conn.accessTokenExpiresAt) : null,
    lastConnectedAt: iso(conn.lastConnectedAt),
    lastRefreshedAt: iso(conn.lastRefreshedAt),
    lastErrorCode: conn.lastErrorCode,
  };
}

/** Chamada autenticada a /users/me usando (e renovando, se preciso) o token armazenado. */
export async function verifyConnection(): Promise<{ meliUserId: string; nickname: string | null; siteId: string | null }> {
  const token = await getValidAccessToken();
  const user = await getUserMe(token.accessToken);
  if (String(user.id) !== token.meliUserId) {
    throw new MeliApiError("user_mismatch", 409, "Conta do token difere da conta conectada");
  }
  return { meliUserId: token.meliUserId, nickname: user.nickname, siteId: user.siteId };
}

/**
 * Desconecta a conta: tenta revogar a autorização no Mercado Livre
 * (DELETE /users/{id}/applications/{app_id}) e SEMPRE apaga os tokens locais.
 * Se a revogação remota falhar, a autorização pode continuar listada no ML
 * até o vendedor removê-la em "Minha conta > Segurança > Aplicativos conectados".
 */
export async function disconnect(): Promise<{ hadConnection: boolean; revokedRemotely: boolean }> {
  const store = getStore();
  const conn = await store.getCurrentConnection();
  if (!conn || conn.status === "DISCONNECTED") return { hadConnection: false, revokedRemotely: false };

  let revokedRemotely = false;
  if (conn.status === "ACTIVE" && conn.refreshTokenEnc) {
    try {
      const token = await getValidAccessToken({ maxWaitMs: 5_000 });
      revokedRemotely = await revokeUserGrant(token.accessToken, token.meliUserId);
    } catch (err) {
      const errorCode = err instanceof MeliAuthError ? err.code : err instanceof MeliApiError ? err.errorCode : "unknown";
      logger.warn("Revogação remota não realizada; removendo tokens locais", { errorCode });
    }
  }

  await store.clearTokens(conn.id);
  logger.info("Conta Mercado Livre desconectada", { meliUserId: conn.meliUserId, revokedRemotely });
  return { hadConnection: true, revokedRemotely };
}
