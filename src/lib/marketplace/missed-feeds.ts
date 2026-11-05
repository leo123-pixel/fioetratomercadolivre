import "server-only";
import { getEnv } from "../env";
import { MeliHttpError, meliRequest } from "../meli/api";
import type { Sql } from "../sql";
import { withReadRetry } from "./errors";
import { ingestNotification, SUPPORTED_TOPICS } from "./events";

/**
 * Recuperação de notificações que o ML não conseguiu entregar (GET /missed_feeds?app_id=...).
 * - O ML guarda as mensagens por até 2 dias; consultas do tópico "items" exigem site_id=MLB (sem ele: HTTP 400).
 * - Cada mensagem entra pela mesma ingestão do webhook, deduplicada pelo _id: reprocessar é idempotente.
 * - Não substitui a reconciliação periódica dos anúncios, que corrige o que nenhum evento informou.
 */
interface MissedMessage {
  _id?: string;
  resource?: string;
  user_id?: number | string;
  topic?: string;
  application_id?: number | string;
  attempts?: number;
  sent?: string;
  received?: string;
  actions?: string[];
  request?: { data?: string };
}

const PAGE = 50;
const MAX_PAGES = 20;

export interface MissedFeedsResult {
  fetched: number;
  stored: number;
  duplicates: number;
  rejected: number;
  topicErrors: Record<string, string>;
}

export async function recoverMissedFeeds(sql: Sql, topics: string[] = SUPPORTED_TOPICS): Promise<MissedFeedsResult> {
  const appId = getEnv().MELI_CLIENT_ID;
  const out: MissedFeedsResult = { fetched: 0, stored: 0, duplicates: 0, rejected: 0, topicErrors: {} };
  for (const topic of topics) {
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await withReadRetry(() =>
          meliRequest<{ messages?: MissedMessage[]; total?: number }>("/missed_feeds", {
            auth: true,
            query: { app_id: appId, topic, offset: page * PAGE, limit: PAGE, site_id: topic === "items" || topic === "items_prices" ? "MLB" : undefined },
          }),
        );
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        for (const m of messages) {
          out.fetched++;
          let body: Record<string, unknown> = { ...m };
          // O corpo original enviado ao webhook vem em request.data; os campos de topo têm prioridade.
          if (typeof m.request?.data === "string") {
            try {
              body = { ...(JSON.parse(m.request.data) as Record<string, unknown>), ...body };
            } catch {
              // mantém os campos de topo
            }
          }
          delete body.request;
          delete body.response;
          const r = await ingestNotification(sql, body, { source: "missed_feeds", eventId: m._id });
          if (r.outcome === "stored") out.stored++;
          else if (r.outcome === "duplicate") out.duplicates++;
          else out.rejected++;
        }
        const total = typeof data?.total === "number" ? data.total : null;
        if (messages.length < PAGE || (total !== null && (page + 1) * PAGE >= total)) break;
      }
    } catch (err) {
      if (err instanceof MeliHttpError && err.kind === "auth") throw err;
      out.topicErrors[topic] = err instanceof Error ? err.message.slice(0, 300) : "erro";
    }
  }
  return out;
}
