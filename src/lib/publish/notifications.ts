import "server-only";
import { z } from "zod";
import { getEnv } from "../env";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { ITEM_ID_RE, syncItem } from "./listings";

/**
 * Notificações do Mercado Livre (tópico "items"), configuradas na aplicação do DevCenter.
 *
 * O ML não assina as notificações, então o corpo NUNCA é tratado como verdade: serve só de gatilho.
 * O status é relido com o token da conta em GET /items/{id} (somente leitura) e apenas para anúncios
 * que este sistema publicou nessa mesma conta.
 */
const notificationSchema = z.object({
  resource: z.string().max(200),
  user_id: z.union([z.number(), z.string()]).transform(String),
  topic: z.string().max(60),
  application_id: z.union([z.number(), z.string()]).transform(String).optional(),
});

export const ITEM_TOPICS = ["items", "items_prices"];

/** Valida a notificação; devolve a tarefa de releitura (a executar depois da resposta) ou null. */
export function parseItemNotification(body: unknown): { itemId: string; userId: string } | null {
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return null;
  const n = parsed.data;
  if (!ITEM_TOPICS.includes(n.topic)) return null;
  const itemId = /^\/items\/(MLB\d+)$/.exec(n.resource)?.[1];
  if (!itemId || !ITEM_ID_RE.test(itemId)) return null;
  if (n.application_id && n.application_id !== getEnv().MELI_CLIENT_ID) return null;
  return { itemId, userId: n.user_id };
}

/** Relê o item se ele foi publicado por este sistema na mesma conta. Nunca lança. */
export async function processItemNotification(sql: Sql, n: { itemId: string; userId: string }): Promise<string | null> {
  try {
    const [owned] = await sql.query<{ id: number }>(
      `SELECT id FROM marketplace_listings WHERE marketplace_item_id = $1::text AND marketplace_account_id = $2::text LIMIT 1`,
      [n.itemId, n.userId],
    );
    if (!owned) return null;
    return await syncItem(sql, n.itemId);
  } catch (err) {
    logger.warn("Falha ao processar notificação do Mercado Livre", { itemId: n.itemId, err });
    return null;
  }
}
