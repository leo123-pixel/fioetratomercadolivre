import "server-only";
import { getEnv } from "../env";
import { logger } from "../logger";

export const MELI_AUTH_URL = "https://auth.mercadolivre.com.br/authorization";
export const MELI_API_BASE = "https://api.mercadolibre.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface MeliTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  user_id: number;
  refresh_token: string;
}

export interface MeliUser {
  id: number;
  nickname: string | null;
  siteId: string | null;
}

/** Erro da API do Mercado Livre. Nunca carrega tokens nem o corpo bruto da resposta. */
export class MeliApiError extends Error {
  constructor(
    readonly errorCode: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MeliApiError";
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function request(url: string, init: RequestInit, operation: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    logger.error("Falha de rede ao chamar o Mercado Livre", { operation, err });
    throw new MeliApiError("network_error", 0, `Falha de rede em ${operation}`);
  }
}

export function buildAuthorizationUrl(input: { state: string; codeChallenge?: string }): string {
  const env = getEnv();
  const url = new URL(MELI_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.MELI_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.MELI_REDIRECT_URI);
  url.searchParams.set("state", input.state);
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** POST /oauth/token em application/x-www-form-urlencoded. Sem retry automático (refresh token é de uso único). */
async function postToken(params: Record<string, string>, operation: string): Promise<MeliTokenResponse> {
  const env = getEnv();
  const body = new URLSearchParams({ ...params, client_id: env.MELI_CLIENT_ID, client_secret: env.MELI_CLIENT_SECRET });
  const res = await request(
    `${MELI_API_BASE}/oauth/token`,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    operation,
  );
  const data = await readJson(res);
  if (!res.ok) {
    const errorCode = typeof data.error === "string" ? data.error : `http_${res.status}`;
    logger.warn("Mercado Livre recusou a operação de token", { operation, status: res.status, errorCode });
    throw new MeliApiError(errorCode, res.status, `Mercado Livre retornou ${errorCode} em ${operation}`);
  }
  if (
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number" ||
    (typeof data.user_id !== "number" && typeof data.user_id !== "string")
  ) {
    throw new MeliApiError("invalid_token_response", res.status, `Resposta de token incompleta em ${operation}`);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: String(data.token_type ?? "bearer"),
    scope: typeof data.scope === "string" ? data.scope : undefined,
    user_id: Number(data.user_id),
  };
}

export function exchangeAuthorizationCode(code: string, codeVerifier: string | null): Promise<MeliTokenResponse> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: getEnv().MELI_REDIRECT_URI,
  };
  if (codeVerifier) params.code_verifier = codeVerifier;
  return postToken(params, "authorization_code");
}

export function refreshAccessToken(refreshToken: string): Promise<MeliTokenResponse> {
  return postToken({ grant_type: "refresh_token", refresh_token: refreshToken }, "refresh_token");
}

export async function getUserMe(accessToken: string): Promise<MeliUser> {
  const res = await request(
    `${MELI_API_BASE}/users/me`,
    { headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } },
    "users_me",
  );
  const data = await readJson(res);
  if (!res.ok || typeof data.id !== "number") {
    const errorCode = typeof data.error === "string" ? data.error : `http_${res.status}`;
    throw new MeliApiError(errorCode, res.status, "Falha ao consultar /users/me");
  }
  return {
    id: data.id,
    nickname: typeof data.nickname === "string" ? data.nickname : null,
    siteId: typeof data.site_id === "string" ? data.site_id : null,
  };
}

/** DELETE /users/{user_id}/applications/{app_id}: revoga a autorização do vendedor para a aplicação. */
export async function revokeUserGrant(accessToken: string, meliUserId: string): Promise<boolean> {
  const url = `${MELI_API_BASE}/users/${encodeURIComponent(meliUserId)}/applications/${encodeURIComponent(getEnv().MELI_CLIENT_ID)}`;
  const res = await request(url, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }, "revoke_grant");
  if (!res.ok) logger.warn("Revogação remota não confirmada", { status: res.status });
  return res.ok;
}
