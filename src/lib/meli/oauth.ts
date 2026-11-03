import "server-only";
import { CryptoContext, createPkcePair, decryptSecret, encryptSecret, randomToken, sha256Hex } from "../crypto";
import { getEnv } from "../env";
import { logger } from "../logger";
import { getStore } from "../store";
import type { ConnectionRecord } from "../store/types";
import { buildAuthorizationUrl, exchangeAuthorizationCode, getUserMe, MeliApiError } from "./client";

export const STATE_TTL_MS = 10 * 60 * 1000;

/** Cookie HttpOnly que amarra o state ao navegador que iniciou o fluxo. */
export function bindingCookieName(): string {
  return getEnv().secureCookies ? "__Secure-ft_meli_oauth" : "ft_meli_oauth";
}

export const BINDING_COOKIE_PATH = "/api/auth/mercadolivre";

export async function startAuthorization(now = new Date()): Promise<{ authorizationUrl: string; bindingNonce: string }> {
  const env = getEnv();
  const store = getStore();
  const state = randomToken(32);
  const bindingNonce = randomToken(32);

  let codeChallenge: string | undefined;
  let codeVerifierEnc: string | null = null;
  if (env.MELI_PKCE_ENABLED) {
    const pkce = createPkcePair();
    codeChallenge = pkce.codeChallenge;
    codeVerifierEnc = encryptSecret(pkce.codeVerifier, CryptoContext.pkceVerifier);
  }

  await store.createOAuthState({
    stateHash: sha256Hex(state),
    bindingHash: sha256Hex(bindingNonce),
    codeVerifierEnc,
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
  });

  // Limpeza oportunista; falha aqui não bloqueia o fluxo.
  store.deleteExpiredOAuthStates(now).catch((err) => logger.warn("Falha ao limpar states expirados", { err }));

  return { authorizationUrl: buildAuthorizationUrl({ state, codeChallenge }), bindingNonce };
}

export type CallbackErrorCode =
  | "missing_state"
  | "invalid_state"
  | "access_denied"
  | "invalid_operator_user_id"
  | "authorization_error"
  | "missing_code"
  | "token_exchange_failed"
  | "account_verification_failed";

export type CallbackResult = { ok: true; connection: ConnectionRecord } | { ok: false; error: CallbackErrorCode };

const KNOWN_AUTH_ERRORS: Record<string, CallbackErrorCode> = {
  access_denied: "access_denied",
  invalid_operator_user_id: "invalid_operator_user_id",
};

export async function handleCallback(
  input: { code: string | null; state: string | null; error: string | null; bindingNonce: string | null },
  now = new Date(),
): Promise<CallbackResult> {
  const store = getStore();

  if (!input.state) return { ok: false, error: "missing_state" };
  if (!input.bindingNonce) return { ok: false, error: "invalid_state" };

  // Consumo atômico: valida existência, expiração, binding com o navegador e uso único.
  const record = await store.consumeOAuthState(sha256Hex(input.state), sha256Hex(input.bindingNonce), now);
  if (!record) {
    logger.warn("Callback OAuth com state inválido, expirado, reutilizado ou de outra sessão");
    return { ok: false, error: "invalid_state" };
  }

  if (input.error) {
    logger.warn("Mercado Livre retornou erro de autorização", { errorCode: input.error.slice(0, 64) });
    return { ok: false, error: KNOWN_AUTH_ERRORS[input.error] ?? "authorization_error" };
  }
  if (!input.code) return { ok: false, error: "missing_code" };

  const codeVerifier = record.codeVerifierEnc ? decryptSecret(record.codeVerifierEnc, CryptoContext.pkceVerifier) : null;
  if (getEnv().MELI_PKCE_ENABLED && !codeVerifier) {
    logger.error("PKCE habilitado, mas o state não possui code_verifier");
    return { ok: false, error: "invalid_state" };
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(input.code, codeVerifier);
  } catch (err) {
    logger.error("Falha na troca do authorization code", { errorCode: err instanceof MeliApiError ? err.errorCode : "unknown" });
    return { ok: false, error: "token_exchange_failed" };
  }

  // Confirma a conta autorizada antes de persistir qualquer token.
  let user;
  try {
    user = await getUserMe(tokens.access_token);
  } catch (err) {
    logger.error("Falha ao confirmar conta em /users/me", { errorCode: err instanceof MeliApiError ? err.errorCode : "unknown" });
    return { ok: false, error: "account_verification_failed" };
  }
  if (String(user.id) !== String(tokens.user_id)) {
    logger.error("user_id do token difere de /users/me");
    return { ok: false, error: "account_verification_failed" };
  }

  const meliUserId = String(user.id);
  const connection = await store.saveAuthorizedConnection({
    meliUserId,
    nickname: user.nickname,
    siteId: user.siteId,
    accessTokenEnc: encryptSecret(tokens.access_token, CryptoContext.accessToken(meliUserId)),
    refreshTokenEnc: encryptSecret(tokens.refresh_token, CryptoContext.refreshToken(meliUserId)),
    accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
    scope: tokens.scope ?? null,
    connectedAt: now,
  });

  logger.info("Conta Mercado Livre conectada", { meliUserId, siteId: user.siteId });
  return { ok: true, connection };
}
