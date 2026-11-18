import "server-only";
import { randomToken, sha256Hex } from "../crypto";
import { getEnv } from "../env";
import { logger, redactString } from "../logger";
import type { Sql } from "../sql";
import { NuvemshopApiClient, NuvemshopApiError, type NsStore } from "./client";
import { getNuvemshopEnv, REQUIRED_SCOPES_PHASE1 } from "./env";
import { OtherStoreConnectedError, saveAuthorizedStore, type StoreRow } from "./store";

/**
 * NuvemshopOAuthService — OAuth 2.0 (somente authorization code), conforme a documentação oficial:
 *   1. GET {auth}/apps/{app_id}/authorize?state=... (o lojista aceita os escopos definidos no aplicativo);
 *   2. retorno na URL de redirecionamento com ?code (expira em 5 min) e o mesmo state;
 *   3. POST {auth}/apps/authorize/token com JSON {client_id, client_secret, grant_type, code}
 *      → {access_token, token_type, scope, user_id}; user_id é o ID da loja.
 * O token não expira: só é invalidado por um novo token do mesmo app × loja ou pela desinstalação.
 * Não existe refresh token (e nenhum é simulado aqui).
 *
 * Proteção CSRF: state aleatório de uso único, guardado só como hash, amarrado ao navegador por um
 * cookie HttpOnly e válido por 10 minutos. Um retorno sem state (instalação iniciada fora do painel)
 * é recusado: a conexão deve partir do botão "Conectar loja" do integrador.
 */
export const STATE_TTL_MS = 10 * 60 * 1000;
export const BINDING_COOKIE_PATH = "/api/auth/nuvemshop";

export function bindingCookieName(): string {
  return getEnv().secureCookies ? "__Secure-ft_ns_oauth" : "ft_ns_oauth";
}

export async function startAuthorization(sql: Sql, actor: string, now = new Date()): Promise<{ authorizationUrl: string; bindingNonce: string }> {
  const env = getNuvemshopEnv();
  const state = randomToken(32);
  const bindingNonce = randomToken(32);
  await sql.execute(`INSERT INTO nuvemshop_oauth_states (state_hash, binding_hash, requested_by, expires_at) VALUES ($1, $2, $3, $4::timestamptz)`, [
    sha256Hex(state),
    sha256Hex(bindingNonce),
    actor,
    new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  ]);
  sql.execute(`DELETE FROM nuvemshop_oauth_states WHERE expires_at < $1::timestamptz - interval '1 day'`, [now.toISOString()]).catch((err) => logger.warn("Falha ao limpar states Nuvemshop", { err }));
  const url = new URL(`${env.authBaseUrl}/apps/${env.appId}/authorize`);
  url.searchParams.set("state", state);
  return { authorizationUrl: url.toString(), bindingNonce };
}

export type CallbackErrorCode =
  | "missing_state"
  | "invalid_state"
  | "access_denied"
  | "authorization_error"
  | "missing_code"
  | "token_exchange_failed"
  | "store_verification_failed"
  | "store_mismatch"
  | "insufficient_scope"
  | "other_store_connected";

export type CallbackResult = { ok: true; store: StoreRow; reinstalled: boolean } | { ok: false; error: CallbackErrorCode; detail?: string };

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  user_id?: string | number;
  error?: string;
  error_description?: string;
}

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
}

async function exchangeCode(code: string, deps: OAuthDeps): Promise<{ accessToken: string; scope: string | null; storeId: string }> {
  const env = getNuvemshopEnv();
  const f = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const res = await f(`${env.authBaseUrl}/apps/authorize/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json", "User-Agent": env.userAgent },
    // Credenciais no corpo JSON (nunca na URL), como exige a documentação.
    body: JSON.stringify({ client_id: env.appId, client_secret: env.clientSecret, grant_type: "authorization_code", code }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
    redirect: "error",
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error || !data.access_token || data.user_id === undefined || data.user_id === null) {
    throw new Error(redactString(`Troca do code recusada (${res.status}${data.error ? `: ${data.error}` : ""}${data.error_description ? ` — ${data.error_description}` : ""})`));
  }
  const storeId = String(data.user_id);
  if (!/^\d{1,20}$/.test(storeId)) throw new Error("user_id inválido na resposta do token");
  return { accessToken: data.access_token, scope: data.scope ?? null, storeId };
}

export function scopesFrom(scope: string | null): Set<string> {
  return new Set((scope ?? "").split(/[,\s]+/).filter(Boolean));
}

/**
 * Escopos que faltam para a Fase 1. Um escopo de escrita implica o de leitura. read_locations é concedido
 * automaticamente a quem tem read_products/write_products (pode não aparecer na string): se faltar de fato,
 * GET /locations responde 403 e o painel mostra a capacidade como indisponível.
 */
export function missingScopes(scope: string | null): string[] {
  const s = scopesFrom(scope);
  return REQUIRED_SCOPES_PHASE1.filter((r) => {
    if (s.has(r) || s.has(r.replace(/^read_/, "write_"))) return false;
    if (r === "read_locations") return !(s.has("read_products") || s.has("write_products"));
    return true;
  });
}

export async function handleCallback(
  sql: Sql,
  input: { code: string | null; state: string | null; error: string | null; bindingNonce: string | null; actor: string },
  deps: OAuthDeps = {},
  now = new Date(),
): Promise<CallbackResult> {
  if (!input.state) return { ok: false, error: "missing_state" };
  if (!input.bindingNonce) return { ok: false, error: "invalid_state" };

  // Consumo atômico: existe, não expirou, pertence a este navegador e nunca foi usado.
  const consumed = await sql.query<{ id: string }>(
    `UPDATE nuvemshop_oauth_states SET consumed_at = $3::timestamptz
     WHERE state_hash = $1 AND binding_hash = $2 AND consumed_at IS NULL AND expires_at > $3::timestamptz RETURNING id::text AS id`,
    [sha256Hex(input.state), sha256Hex(input.bindingNonce), now.toISOString()],
  );
  if (!consumed.length) {
    logger.warn("Callback Nuvemshop com state inválido, expirado, reutilizado ou de outro navegador");
    return { ok: false, error: "invalid_state" };
  }
  if (input.error) {
    logger.warn("Nuvemshop retornou erro de autorização", { errorCode: input.error.slice(0, 64) });
    return { ok: false, error: input.error === "access_denied" ? "access_denied" : "authorization_error" };
  }
  if (!input.code) return { ok: false, error: "missing_code" };

  let token;
  try {
    token = await exchangeCode(input.code, deps);
  } catch (err) {
    logger.error("Falha na troca do authorization code da Nuvemshop", { err });
    return { ok: false, error: "token_exchange_failed" };
  }

  const missing = missingScopes(token.scope);
  if (missing.length) {
    logger.warn("Aplicativo Nuvemshop sem os escopos necessários", { missing });
    return { ok: false, error: "insufficient_scope", detail: missing.join(", ") };
  }

  // Confirma a loja autorizada antes de gravar o token: GET /store deve responder com o mesmo id.
  let info: NsStore;
  try {
    const env = getNuvemshopEnv();
    const client = new NuvemshopApiClient({ storeId: token.storeId, accessToken: token.accessToken, env, fetchImpl: deps.fetchImpl, maxRetries: 2 });
    info = (await client.get<NsStore>("/store")).data;
  } catch (err) {
    logger.error("Falha ao confirmar a loja Nuvemshop em GET /store", { kind: err instanceof NuvemshopApiError ? err.kind : "unknown" });
    return { ok: false, error: "store_verification_failed" };
  }
  if (!info || String(info.id) !== token.storeId) {
    logger.error("GET /store devolveu loja diferente do user_id do token");
    return { ok: false, error: "store_mismatch" };
  }

  const env = getNuvemshopEnv();
  const previous = await sql.query<{ id: string }>(`SELECT id::text AS id FROM nuvemshop_stores WHERE app_id = $1 AND store_id = $2`, [env.appId, token.storeId]);
  try {
    const store = await saveAuthorizedStore(sql, { appId: env.appId, storeId: token.storeId, accessToken: token.accessToken, scopes: token.scope, info, actor: input.actor, now });
    logger.info("Loja Nuvemshop conectada", { storeId: token.storeId, reinstalled: previous.length > 0 });
    return { ok: true, store, reinstalled: previous.length > 0 };
  } catch (err) {
    if (err instanceof OtherStoreConnectedError) return { ok: false, error: "other_store_connected", detail: err.connectedStoreId };
    throw err;
  }
}
