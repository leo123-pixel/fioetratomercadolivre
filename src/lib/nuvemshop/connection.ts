import "server-only";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { upsertLocations } from "./catalog";
import { NuvemshopApiError, type NsLocation, type NsStore } from "./client";
import { isNuvemshopConfigured } from "./env";
import { missingScopes } from "./oauth";
import { nuvemshopReadOnlyState } from "./read-only";
import { clientForConnectedStore, getLatestStore, recordStoreError, updateStoreInfo, type StoreRow } from "./store";

export interface ConnectionCheck {
  ok: boolean;
  storeId: string | null;
  storeName: string | null;
  planName: string | null;
  locations: number | null;
  multiLocation: boolean | null;
  error: { kind: string; message: string } | null;
  checkedAt: string;
}

/**
 * Valida a conexão com uma consulta REAL à API (GET /store e GET /locations) e detecta as capacidades
 * observadas na loja (não presume recursos só porque a API os documenta).
 */
export async function checkConnection(sql: Sql, deps: { fetchImpl?: typeof fetch } = {}, now = new Date()): Promise<ConnectionCheck> {
  const { store, client } = await clientForConnectedStore(sql, { fetchImpl: deps.fetchImpl, maxRetries: 2 });
  const base = { storeId: store.storeId, checkedAt: now.toISOString() };
  try {
    const info = (await client.get<NsStore>("/store")).data;
    if (String(info?.id) !== store.storeId) throw new NuvemshopApiError("invalid_response", "GET /store devolveu outra loja");
    let locations: NsLocation[] | null = null;
    let locationsError: string | null = null;
    try {
      const r = (await client.get<NsLocation[]>("/locations")).data;
      locations = Array.isArray(r) ? r : null;
    } catch (err) {
      if (err instanceof NuvemshopApiError && (err.kind === "forbidden" || err.kind === "not_found")) locationsError = err.kind;
      else throw err;
    }
    const [inv] = await sql.query<{ withLevels: number; total: number }>(
      `SELECT count(*) FILTER (WHERE has_inventory_levels)::int AS "withLevels", count(*)::int AS total FROM nuvemshop_variants WHERE store_id = $1 AND sync_status = 'ACTIVE'`,
      [store.storeId],
    );
    const capabilities = {
      storeReadable: true,
      locationsReadable: locations !== null,
      locationsError,
      variantsWithInventoryLevels: inv?.withLevels ?? 0,
      variantsImported: inv?.total ?? 0,
      missingScopes: missingScopes(store.grantedScopes),
      checkedAt: now.toISOString(),
    };
    await sql.transaction(async (tx) => {
      if (locations) await upsertLocations(tx, store.storeId, locations, now);
      await updateStoreInfo(tx, store.storeId, info, capabilities, locations ? locations.length : null, now);
    });
    const fresh = await getLatestStore(sql);
    return {
      ...base,
      ok: true,
      storeName: fresh?.storeName ?? null,
      planName: fresh?.planName ?? null,
      locations: locations ? locations.length : null,
      multiLocation: fresh?.multiLocation ?? null,
      error: null,
    };
  } catch (err) {
    const kind = err instanceof NuvemshopApiError ? err.kind : "internal";
    const message = err instanceof Error ? err.message : "Erro";
    await recordStoreError(sql, store.storeId, message, kind === "unauthorized");
    logger.warn("Verificação da conexão Nuvemshop falhou", { kind });
    return { ...base, ok: false, storeName: store.storeName, planName: store.planName, locations: null, multiLocation: store.multiLocation, error: { kind, message } };
  }
}

export interface ConnectionView {
  configured: boolean;
  readOnly: ReturnType<typeof nuvemshopReadOnlyState>;
  store: (Omit<StoreRow, "hasToken"> & { missingScopes: string[] }) | null;
}

/** Estado para o painel (sem token, sem dados pessoais do lojista). */
export async function connectionView(sql: Sql): Promise<ConnectionView> {
  const store = await getLatestStore(sql);
  return {
    configured: isNuvemshopConfigured(),
    readOnly: nuvemshopReadOnlyState(),
    store: store ? (({ hasToken: _h, ...s }) => ({ ...s, missingScopes: missingScopes(s.grantedScopes) }))(store) : null,
  };
}
