import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { getNuvemshopEnv } from "./env";

/**
 * Webhooks obrigatórios de privacidade do aplicativo (store/redact, customers/redact, customers/data_request).
 * Verificação: x-linkedstore-hmac-sha256 = HMAC-SHA256 (hex) do corpo original com o segredo do aplicativo.
 *
 * Dados pessoais guardados: só os dados fiscais do comprador lidos SOB DEMANDA para o envio do pedido à ADS
 * (nuvemshop_order_billing). customers/redact apaga os dos pedidos indicados (orders_to_redact);
 * customers/data_request registra quantos pedidos com dados guardados existem para o atendimento manual.
 * store/redact apaga o token, o catálogo importado e todos os dados de compradores da loja (mantém só os registros
 * internos de decisão de vínculo e de envio à ADS, que não contêm dados pessoais — o payload guarda o documento
 * mascarado).
 */
export type PrivacyTopic = "store/redact" | "customers/redact" | "customers/data_request";

const orderIdsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => /^\d{1,20}$/.test(x)).slice(0, 5000) : []);

export function verifyWebhookSignature(rawBody: string, header: string | null, secret = getNuvemshopEnv().clientSecret): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  const given = Buffer.from(header.trim().toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handlePrivacyWebhook(
  sql: Sql,
  topic: PrivacyTopic,
  payload: { store_id?: number | string; orders_to_redact?: unknown; orders_requested?: unknown },
): Promise<{ handled: boolean; action: string }> {
  const storeId = payload?.store_id !== undefined ? String(payload.store_id) : null;
  if (!storeId || !/^\d{1,20}$/.test(storeId)) return { handled: false, action: "store_id ausente" };
  if (topic === "customers/redact") {
    const ids = orderIdsOf(payload.orders_to_redact);
    const removed = ids.length ? await sql.execute(`DELETE FROM nuvemshop_order_billing WHERE store_id = $1 AND order_id = ANY($2::bigint[])`, [storeId, ids]) : 0;
    logger.info("Webhook customers/redact Nuvemshop processado", { storeId, orders: ids.length, removed });
    return { handled: true, action: `dados do comprador apagados em ${removed} pedido(s)` };
  }
  if (topic === "customers/data_request") {
    const ids = orderIdsOf(payload.orders_requested);
    const [row] = ids.length
      ? await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM nuvemshop_order_billing WHERE store_id = $1 AND order_id = ANY($2::bigint[])`, [storeId, ids])
      : [{ n: 0 }];
    logger.warn("Webhook customers/data_request Nuvemshop: atender manualmente", { storeId, orders: ids.length, ordersWithData: row?.n ?? 0 });
    return { handled: true, action: `${row?.n ?? 0} pedido(s) com dados do comprador guardados (atendimento manual)` };
  }
  await sql.transaction(async (tx) => {
    await tx.execute(`DELETE FROM nuvemshop_order_billing WHERE store_id = $1`, [storeId]);
    await tx.execute(
      `UPDATE nuvemshop_stores SET connection_status = 'DISCONNECTED', encrypted_access_token = NULL, disconnected_at = now(), raw_store = NULL,
         last_error = 'Dados da loja apagados a pedido (store/redact)', updated_at = now() WHERE store_id = $1`,
      [storeId],
    );
    await tx.execute(`DELETE FROM nuvemshop_catalog_import_jobs WHERE store_id = $1`, [storeId]);
    await tx.execute(`DELETE FROM nuvemshop_inventory_levels WHERE store_id = $1`, [storeId]);
    await tx.execute(`DELETE FROM nuvemshop_locations WHERE store_id = $1`, [storeId]);
    await tx.execute(`DELETE FROM nuvemshop_categories WHERE store_id = $1`, [storeId]);
    // Vínculos ficam (registro de decisão interna), mas sem os dados do catálogo.
    await tx.execute(`DELETE FROM nuvemshop_product_images WHERE store_id = $1`, [storeId]);
    await tx.execute(`UPDATE nuvemshop_variants SET raw_payload = '{}'::jsonb, sync_status = 'REMOVED', removed_at = COALESCE(removed_at, now()) WHERE store_id = $1`, [storeId]);
    await tx.execute(
      `UPDATE nuvemshop_products SET raw_payload = '{}'::jsonb, description = NULL, names = NULL, sync_status = 'REMOVED', removed_at = COALESCE(removed_at, now()) WHERE store_id = $1`,
      [storeId],
    );
  });
  logger.info("Webhook store/redact Nuvemshop processado", { storeId });
  return { handled: true, action: "token e catálogo da loja apagados" };
}
