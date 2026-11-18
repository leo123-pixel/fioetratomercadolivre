import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { getNuvemshopEnv } from "./env";

/**
 * Webhooks obrigatórios de privacidade do aplicativo (store/redact, customers/redact, customers/data_request).
 * Verificação: x-linkedstore-hmac-sha256 = HMAC-SHA256 (hex) do corpo original com o segredo do aplicativo.
 *
 * Fase 1 não guarda dados de clientes nem pedidos da Nuvemshop: customers/* só registra o recebimento.
 * store/redact apaga o token e o catálogo importado da loja (mantém só os registros internos de decisão de
 * vínculo, que não contêm dados pessoais).
 */
export type PrivacyTopic = "store/redact" | "customers/redact" | "customers/data_request";

export function verifyWebhookSignature(rawBody: string, header: string | null, secret = getNuvemshopEnv().clientSecret): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  const given = Buffer.from(header.trim().toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handlePrivacyWebhook(sql: Sql, topic: PrivacyTopic, payload: { store_id?: number | string }): Promise<{ handled: boolean; action: string }> {
  const storeId = payload?.store_id !== undefined ? String(payload.store_id) : null;
  if (!storeId || !/^\d{1,20}$/.test(storeId)) return { handled: false, action: "store_id ausente" };
  if (topic !== "store/redact") {
    logger.info("Webhook de privacidade Nuvemshop recebido (sem dados de clientes armazenados)", { topic, storeId });
    return { handled: true, action: "nenhum dado de cliente armazenado" };
  }
  await sql.transaction(async (tx) => {
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
