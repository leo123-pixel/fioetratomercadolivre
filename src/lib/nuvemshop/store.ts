import "server-only";
import { decryptSecret, encryptSecret } from "../crypto";
import { isUniqueViolation, type Sql } from "../sql";
import { NuvemshopApiClient, pickText, type NsStore } from "./client";
import { getNuvemshopEnv } from "./env";

/** Contexto (AAD) do token: amarra o ciphertext ao par app × loja (um token não serve para outra loja). */
export const tokenContext = (appId: string, storeId: string) => `nuvemshop:access_token:${appId}:${storeId}`;

export type ConnectionStatus = "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";

export interface StoreRow {
  id: string;
  appId: string;
  storeId: string;
  storeName: string | null;
  storeUrl: string | null;
  originalDomain: string | null;
  planName: string | null;
  mainLanguage: string | null;
  mainCurrency: string | null;
  country: string | null;
  multiLocation: boolean | null;
  locationCount: number | null;
  capabilities: Record<string, unknown>;
  connectionStatus: ConnectionStatus;
  grantedScopes: string | null;
  connectedBy: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastSuccessfulCheckAt: Date | null;
  lastError: string | null;
  hasToken: boolean;
}

const COLS = `id::text AS id, app_id AS "appId", store_id AS "storeId", store_name AS "storeName", store_url AS "storeUrl",
  original_domain AS "originalDomain", plan_name AS "planName", main_language AS "mainLanguage", main_currency AS "mainCurrency", country,
  multi_location AS "multiLocation", location_count AS "locationCount", capabilities, connection_status AS "connectionStatus",
  granted_scopes AS "grantedScopes", connected_by AS "connectedBy", connected_at AS "connectedAt", disconnected_at AS "disconnectedAt",
  last_successful_check_at AS "lastSuccessfulCheckAt", last_error AS "lastError", (encrypted_access_token IS NOT NULL) AS "hasToken"`;

export class NuvemshopNotConnectedError extends Error {
  readonly code = "nuvemshop_not_connected";
  constructor(message = "Nenhuma loja Nuvemshop conectada. Conecte a loja em Nuvemshop.") {
    super(message);
    this.name = "NuvemshopNotConnectedError";
  }
}

export class OtherStoreConnectedError extends Error {
  readonly code = "other_store_connected";
  constructor(readonly connectedStoreId: string) {
    super(`Já existe outra loja Nuvemshop conectada (${connectedStoreId}). Desconecte-a antes de conectar uma loja diferente.`);
    this.name = "OtherStoreConnectedError";
  }
}

/** Loja conectada (ativa ou aguardando reautorização). Fase 1: no máximo uma. */
export async function getConnectedStore(sql: Sql): Promise<StoreRow | null> {
  const [row] = await sql.query<StoreRow>(`SELECT ${COLS} FROM nuvemshop_stores WHERE connection_status <> 'DISCONNECTED' ORDER BY updated_at DESC LIMIT 1`);
  return row ?? null;
}

export async function getLatestStore(sql: Sql): Promise<StoreRow | null> {
  const [row] = await sql.query<StoreRow>(`SELECT ${COLS} FROM nuvemshop_stores ORDER BY (connection_status <> 'DISCONNECTED') DESC, updated_at DESC LIMIT 1`);
  return row ?? null;
}

export function storeFieldsFrom(info: NsStore): Record<string, unknown> {
  return {
    storeName: pickText(info.name ?? null, info.main_language ?? "pt"),
    storeUrl: typeof info.url_with_protocol === "string" ? info.url_with_protocol : null,
    originalDomain: typeof info.original_domain === "string" ? info.original_domain : null,
    planName: typeof info.plan_name === "string" ? info.plan_name : null,
    mainLanguage: typeof info.main_language === "string" ? info.main_language : null,
    mainCurrency: typeof info.main_currency === "string" ? info.main_currency : null,
    country: typeof info.country === "string" ? info.country : null,
    timezoneId: typeof info.timezone_id === "string" ? info.timezone_id : null,
  };
}

/** Dados da loja que não devem ficar guardados (contato pessoal do proprietário). */
function sanitizeStorePayload(info: NsStore): Record<string, unknown> {
  const { email: _e, contact_email: _c, phone: _p, whatsapp_phone_number: _w, business_id: _b, ...rest } = info as Record<string, unknown>;
  return rest;
}

/**
 * Grava a autorização da loja. Reinstalação da mesma loja: substitui o token (o anterior já foi invalidado
 * pela Nuvemshop). Outra loja já conectada: recusa (Fase 1 suporta uma loja por vez).
 */
export async function saveAuthorizedStore(
  sql: Sql,
  input: { appId: string; storeId: string; accessToken: string; scopes: string | null; info: NsStore; actor: string; now?: Date },
): Promise<StoreRow> {
  const now = input.now ?? new Date();
  const f = storeFieldsFrom(input.info);
  return sql.transaction(async (tx) => {
    const others = await tx.query<{ storeId: string }>(
      `SELECT store_id AS "storeId" FROM nuvemshop_stores WHERE connection_status <> 'DISCONNECTED' AND NOT (app_id = $1 AND store_id = $2) FOR UPDATE`,
      [input.appId, input.storeId],
    );
    if (others.length) throw new OtherStoreConnectedError(others[0].storeId);
    try {
      const [row] = await tx.query<StoreRow>(
        `INSERT INTO nuvemshop_stores (app_id, store_id, store_name, store_url, original_domain, plan_name, main_language, main_currency, country, timezone_id,
           connection_status, encrypted_access_token, granted_scopes, connected_by, connected_at, last_successful_check_at, raw_store, last_error, disconnected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,$13,$14::timestamptz,$14::timestamptz,$15::jsonb,NULL,NULL)
         ON CONFLICT (app_id, store_id) DO UPDATE SET store_name = EXCLUDED.store_name, store_url = EXCLUDED.store_url, original_domain = EXCLUDED.original_domain,
           plan_name = EXCLUDED.plan_name, main_language = EXCLUDED.main_language, main_currency = EXCLUDED.main_currency, country = EXCLUDED.country,
           timezone_id = EXCLUDED.timezone_id, connection_status = 'ACTIVE', encrypted_access_token = EXCLUDED.encrypted_access_token,
           granted_scopes = EXCLUDED.granted_scopes, token_version = nuvemshop_stores.token_version + 1, connected_by = EXCLUDED.connected_by,
           connected_at = EXCLUDED.connected_at, last_successful_check_at = EXCLUDED.last_successful_check_at, raw_store = EXCLUDED.raw_store,
           last_error = NULL, disconnected_at = NULL, updated_at = now()
         RETURNING ${COLS}`,
        [
          input.appId,
          input.storeId,
          f.storeName,
          f.storeUrl,
          f.originalDomain,
          f.planName,
          f.mainLanguage,
          f.mainCurrency,
          f.country,
          f.timezoneId,
          encryptSecret(input.accessToken, tokenContext(input.appId, input.storeId)),
          input.scopes,
          input.actor,
          now.toISOString(),
          JSON.stringify(sanitizeStorePayload(input.info)),
        ],
      );
      return row;
    } catch (err) {
      // Corrida com outra conexão simultânea: o índice "uma loja conectada" garante a regra.
      if (isUniqueViolation(err)) throw new OtherStoreConnectedError("(outra conexão em andamento)");
      throw err;
    }
  });
}

export async function updateStoreInfo(sql: Sql, storeId: string, info: NsStore, capabilities: Record<string, unknown>, locationCount: number | null, now = new Date()): Promise<void> {
  const f = storeFieldsFrom(info);
  await sql.execute(
    `UPDATE nuvemshop_stores SET store_name = $2, store_url = $3, original_domain = $4, plan_name = $5, main_language = $6, main_currency = $7, country = $8,
       timezone_id = $9, raw_store = $10::jsonb, capabilities = $11::jsonb, location_count = $12::int,
       multi_location = CASE WHEN $12::int IS NULL THEN multi_location ELSE $12::int > 1 END,
       last_successful_check_at = $13::timestamptz, last_error = NULL, updated_at = now()
     WHERE store_id = $1 AND connection_status <> 'DISCONNECTED'`,
    [storeId, f.storeName, f.storeUrl, f.originalDomain, f.planName, f.mainLanguage, f.mainCurrency, f.country, f.timezoneId, JSON.stringify(sanitizeStorePayload(info)), JSON.stringify(capabilities), locationCount, now.toISOString()],
  );
}

export async function recordStoreError(sql: Sql, storeId: string, message: string, reauth: boolean): Promise<void> {
  await sql.execute(
    `UPDATE nuvemshop_stores SET last_error = $2, connection_status = CASE WHEN $3::boolean THEN 'REAUTH_REQUIRED' ELSE connection_status END, updated_at = now()
     WHERE store_id = $1 AND connection_status <> 'DISCONNECTED'`,
    [storeId, message.slice(0, 500), reauth],
  );
}

/** Desconexão administrativa: apaga o token local. O catálogo e os vínculos ficam (histórico). */
export async function disconnectStore(sql: Sql, actor: string, now = new Date()): Promise<StoreRow | null> {
  const [row] = await sql.query<StoreRow>(
    `UPDATE nuvemshop_stores SET connection_status = 'DISCONNECTED', encrypted_access_token = NULL, disconnected_at = $1::timestamptz,
       last_error = $2, updated_at = now()
     WHERE connection_status <> 'DISCONNECTED' RETURNING ${COLS}`,
    [now.toISOString(), `Desconectada por ${actor}`],
  );
  return row ?? null;
}

/** Cliente da Admin API para a loja conectada (o token só existe no servidor). */
export async function clientForConnectedStore(sql: Sql, opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxRetries?: number; timeoutMs?: number } = {}): Promise<{ store: StoreRow; client: NuvemshopApiClient }> {
  const [row] = await sql.query<StoreRow & { token: string | null }>(
    `SELECT ${COLS}, encrypted_access_token AS token FROM nuvemshop_stores WHERE connection_status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`,
  );
  if (!row) {
    const pending = await getConnectedStore(sql);
    if (pending?.connectionStatus === "REAUTH_REQUIRED") throw new NuvemshopNotConnectedError("A autorização da loja Nuvemshop foi revogada ou substituída. Reconecte a loja.");
    throw new NuvemshopNotConnectedError();
  }
  if (!row.token) throw new NuvemshopNotConnectedError();
  const env = getNuvemshopEnv();
  if (row.appId !== env.appId) throw new NuvemshopNotConnectedError("A loja conectada pertence a outro aplicativo Nuvemshop. Reconecte com o aplicativo configurado.");
  const token = decryptSecret(row.token, tokenContext(row.appId, row.storeId));
  const { token: _t, ...store } = row;
  return { store, client: new NuvemshopApiClient({ storeId: row.storeId, accessToken: token, env, ...opts }) };
}
