import "server-only";
import { MeliHttpError, meliRequest } from "../meli/api";
import { ITEM_FIELDS, localStatus, saveIssues, syncItemDetailed, type MeliItemSnapshot } from "../publish/listings";
import type { Sql } from "../sql";
import { PermanentEventError, withReadRetry } from "./errors";
import type { EventHandler, HandlerResult } from "./events";
import { processOrder, processShipment } from "./orders";

/**
 * Handlers por tópico. Todos SÓ LEEM o estado atual do recurso na API autenticada e atualizam o banco
 * local; nenhum chama endpoints de escrita do Mercado Livre nem a ADS, e nenhum aciona publicação.
 */

/** Relê os anúncios locais indicados (status, preço, quantidade, divergências). */
async function resyncListings(sql: Sql, itemIds: string[], eventId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const itemId of itemIds.slice(0, 50)) {
    const r = await syncItemDetailed(sql, itemId, { source: "webhook", eventId });
    out.push({ itemId, status: r.status, changed: r.changed, stale: r.stale, issues: r.issues });
  }
  return out;
}

const items: EventHandler = async (sql, ev) => {
  const itemId = ev.resourceId;
  const [local] = await sql.query<{ id: number }>(
    `SELECT id FROM marketplace_listings WHERE marketplace_item_id = $1::text AND marketplace_account_id = $2::text LIMIT 1`,
    [itemId, ev.sellerId],
  );
  if (local) {
    const [r] = await resyncListings(sql, [itemId], ev.id);
    return { outcome: "completed", result: r };
  }
  // Anúncio da conta que o integrador não conhece: registra como "sem correspondência local" (não vincula).
  let item: MeliItemSnapshot;
  try {
    item = (await withReadRetry(() => meliRequest<MeliItemSnapshot>(`/items/${itemId}`, { auth: true, query: { attributes: ITEM_FIELDS } }))).data;
  } catch (err) {
    if (err instanceof MeliHttpError && err.kind === "not_found") return { outcome: "ignored", reason: "not_found" };
    throw err;
  }
  if (String(item.seller_id ?? "") !== ev.sellerId) return { outcome: "ignored", reason: "other_seller" };
  const sku = item.attributes?.find((a) => a?.id === "SELLER_SKU")?.value_name ?? null;
  await saveIssues(sql, itemId, null, [{ type: "NOT_LINKED", local: null, remote: localStatus(item), details: { title: item.title ?? null, sellerSku: sku, source: "webhook" } }], []);
  return { outcome: "completed", reason: "no_local_listing", result: { itemId, unlinked: true, remoteStatus: item.status ?? null } };
};

const userProducts: EventHandler = async (sql, ev) => {
  const upId = ev.resourceId;
  let familyId: string | null = null;
  if (!ev.actions.includes("purged")) {
    try {
      const { data } = await withReadRetry(() => meliRequest<{ id?: string; family_id?: string | number | null }>(`/user-products/${upId}`, { auth: true }));
      familyId = data?.family_id == null ? null : String(data.family_id);
    } catch (err) {
      if (!(err instanceof MeliHttpError && (err.kind === "not_found" || err.kind === "forbidden"))) throw err;
    }
  }
  const rows = await sql.query<{ itemId: string }>(
    `SELECT marketplace_item_id AS "itemId" FROM marketplace_listings WHERE user_product_id = $1::text AND marketplace_account_id = $2::text AND status <> 'deleted'`,
    [upId, ev.sellerId],
  );
  if (!rows.length) return { outcome: "ignored", reason: "no_local_listing", result: { userProductId: upId, familyId, actions: ev.actions } };
  if (familyId) await sql.execute(`UPDATE marketplace_listings SET family_id = $2::text WHERE user_product_id = $1::text AND family_id IS DISTINCT FROM $2::text`, [upId, familyId]);
  return { outcome: "completed", result: { userProductId: upId, familyId, actions: ev.actions, listings: await resyncListings(sql, rows.map((r) => r.itemId), ev.id) } };
};

const families: EventHandler = async (sql, ev) => {
  const rows = await sql.query<{ itemId: string }>(
    `SELECT marketplace_item_id AS "itemId" FROM marketplace_listings WHERE family_id = $1::text AND marketplace_account_id = $2::text AND status <> 'deleted'`,
    [ev.resourceId, ev.sellerId],
  );
  if (!rows.length) return { outcome: "ignored", reason: "no_local_listing", result: { familyId: ev.resourceId, actions: ev.actions } };
  return { outcome: "completed", result: { familyId: ev.resourceId, actions: ev.actions, listings: await resyncListings(sql, rows.map((r) => r.itemId), ev.id) } };
};

const orders: EventHandler = async (sql, ev): Promise<HandlerResult> => {
  try {
    const r = await processOrder(sql, ev.resourceId);
    if (!r) return { outcome: "ignored", reason: "not_found" };
    return { outcome: "completed", result: r };
  } catch (err) {
    // Falha definitiva num pedido já conhecido fica visível no painel de pedidos.
    if (err instanceof PermanentEventError && err.code === "other_seller") return { outcome: "ignored", reason: "other_seller" };
    if (err instanceof PermanentEventError || ev.attempts >= ev.maxAttempts) {
      await sql.execute(
        `UPDATE marketplace_order_inbox SET ads_import_status = 'ERROR', last_error = $2::text, updated_at = now() WHERE marketplace_order_id = $1::text`,
        [ev.resourceId, (err as Error).message?.slice(0, 500) ?? "erro"],
      );
    }
    throw err;
  }
};

const shipments: EventHandler = async (sql, ev) => {
  const r = await processShipment(sql, ev.resourceId);
  if (!r) return { outcome: "ignored", reason: "not_found" };
  return { outcome: "completed", result: r };
};

export const HANDLERS: Record<string, EventHandler> = {
  items,
  items_prices: items,
  user_products: userProducts,
  user_products_families: families,
  orders_v2: orders,
  shipments,
};

export { PermanentEventError };
