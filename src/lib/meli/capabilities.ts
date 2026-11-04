import "server-only";
import type { Sql } from "../sql";
import { getStore } from "../store";
import { meliRequest } from "./api";

/**
 * Detecção das capacidades da conta vendedora conectada (GET /users/me).
 * Guarda apenas dados necessários à publicação — nada de e-mail, telefone ou endereço.
 */
export type PublicationModel = "USER_PRODUCTS" | "CLASSIC";

export interface SellerCapabilities {
  connected: boolean;
  meliUserId: string | null;
  nickname: string | null;
  siteId: string | null;
  tags: string[];
  /** Tag user_product_seller presente: anúncios usam family_name, sem title e sem variations. */
  userProductSeller: boolean;
  publicationModel: PublicationModel | null;
  /** Escopos concedidos no OAuth (ex.: "offline_access read write"). */
  scope: string | null;
  canWrite: boolean;
  accessTokenExpiresAt: string | null;
  lastRefreshedAt: string | null;
  sellerStatus: string | null;
  fetchedAt: string | null;
  error: string | null;
}

const KEY = "meli_capabilities";
const TTL_MS = 60 * 60 * 1000;

interface UsersMe {
  id: number;
  nickname?: string;
  site_id?: string;
  tags?: unknown;
  status?: { site_status?: string } | null;
}

export function modelFromTags(tags: string[]): PublicationModel {
  return tags.includes("user_product_seller") ? "USER_PRODUCTS" : "CLASSIC";
}

export async function getCapabilities(sql: Sql, opts: { refresh?: boolean } = {}): Promise<SellerCapabilities> {
  const conn = await getStore().getCurrentConnection();
  const base: SellerCapabilities = {
    connected: Boolean(conn && conn.status === "ACTIVE"),
    meliUserId: conn?.meliUserId ?? null,
    nickname: conn?.nickname ?? null,
    siteId: conn?.siteId ?? null,
    tags: [],
    userProductSeller: false,
    publicationModel: null,
    scope: conn?.scope ?? null,
    canWrite: Boolean(conn?.scope && /\bwrite\b/.test(conn.scope)),
    accessTokenExpiresAt: conn?.accessTokenExpiresAt?.toISOString() ?? null,
    lastRefreshedAt: conn?.lastRefreshedAt?.toISOString() ?? null,
    sellerStatus: null,
    fetchedAt: null,
    error: null,
  };
  if (!base.connected) return { ...base, error: conn?.status === "REAUTH_REQUIRED" ? "reauth_required" : "not_connected" };

  if (!opts.refresh) {
    const [cached] = await sql.query<{ value: Partial<SellerCapabilities> & { meliUserId?: string }; fresh: boolean }>(
      `SELECT value, (updated_at > now() - make_interval(secs => $2::int)) AS fresh FROM app_settings WHERE key = $1`,
      [KEY, TTL_MS / 1000],
    );
    if (cached?.fresh && cached.value.meliUserId === base.meliUserId) {
      return { ...base, ...pickCached(cached.value) };
    }
  }

  try {
    const { data } = await meliRequest<UsersMe>("/users/me", { auth: true });
    const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string") : [];
    const detected = {
      meliUserId: String(data.id),
      tags,
      userProductSeller: tags.includes("user_product_seller"),
      publicationModel: modelFromTags(tags),
      sellerStatus: data.status?.site_status ?? null,
      fetchedAt: new Date().toISOString(),
    };
    await sql.execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, JSON.stringify(detected)],
    );
    // Recarrega a conexão: a chamada pode ter renovado o token.
    const fresh = await getStore().getCurrentConnection();
    return {
      ...base,
      ...detected,
      accessTokenExpiresAt: fresh?.accessTokenExpiresAt?.toISOString() ?? base.accessTokenExpiresAt,
      lastRefreshedAt: fresh?.lastRefreshedAt?.toISOString() ?? base.lastRefreshedAt,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : "Falha ao consultar /users/me" };
  }
}

function pickCached(v: Partial<SellerCapabilities>) {
  return {
    tags: v.tags ?? [],
    userProductSeller: v.userProductSeller ?? false,
    publicationModel: v.publicationModel ?? null,
    sellerStatus: v.sellerStatus ?? null,
    fetchedAt: v.fetchedAt ?? null,
  };
}
