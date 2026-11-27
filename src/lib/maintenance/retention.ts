import "server-only";
import { logger } from "../logger";
import type { Sql } from "../sql";

/**
 * Retenção do histórico de diagnóstico das sincronizações automáticas.
 *
 * As automações gravam uma linha por variante/anúncio a cada execução (a cada 5–15 min) e nada era apagado: em
 * 27/11/2026 o banco passou do limite do plano (0,6 / 0,5 GB), com estas 4 tabelas somando ~418 MB. Aqui só sai o
 * que é diagnóstico de execuções antigas; fica sempre:
 *   - a linha mais recente de cada variante (Nuvemshop), estoque (ML) e anúncio (preço ML) — telas e rotinas a leem;
 *   - a proposta de estoque mais recente com modelo de estoque conhecido de cada estoque do ML (adaptador do núcleo);
 *   - propostas em aberto (PROPOSED/APPROVED/APPLYING) e propostas de estoque ligadas a uma atualização (stock_sync_jobs);
 *   - preços efetivamente aplicados no ML (applied_at) — histórico de alterações;
 *   - decisões Nuvemshop ligadas a uma escrita (job_id) por 30 dias.
 * Ledger, snapshots, reservas e movimentos do Inventory Core não são tocados.
 *
 * Apagar não diminui o arquivo do banco (o Postgres reaproveita o espaço): para o tamanho cair no painel do
 * Supabase é preciso um VACUUM FULL nessas tabelas depois da primeira limpeza (docs/retencao-historico.md).
 */
export const RETENTION_DAYS = {
  nuvemshopSyncItems: 3,
  nuvemshopSyncItemsWithJob: 30,
  inventorySyncProposals: 3,
  stockSyncProposals: 7,
  priceSyncProposals: 7,
} as const;

const BATCH = 10_000;
const LAST_RUN_KEY = "history_retention_last";
const MIN_INTERVAL_MS = 60 * 60_000;

interface Rule {
  table: string;
  /** Seleciona ids apagáveis (alias "t"), sem LIMIT. $1 = dias de retenção. */
  candidates: string;
  days: number;
}

const RULES: Rule[] = [
  {
    table: "nuvemshop_sync_items",
    days: RETENTION_DAYS.nuvemshopSyncItems,
    candidates: `SELECT t.id FROM nuvemshop_sync_items t
      WHERE t.created_at < now() - make_interval(days => $1::int)
        AND (t.job_id IS NULL OR t.created_at < now() - make_interval(days => ${RETENTION_DAYS.nuvemshopSyncItemsWithJob}))
        AND t.id NOT IN (SELECT max(id) FROM nuvemshop_sync_items GROUP BY store_id, variant_id, kind)`,
  },
  {
    table: "inventory_sync_proposals",
    days: RETENTION_DAYS.inventorySyncProposals,
    candidates: `SELECT t.id FROM inventory_sync_proposals t WHERE t.created_at < now() - make_interval(days => $1::int)`,
  },
  {
    table: "stock_sync_proposals",
    days: RETENTION_DAYS.stockSyncProposals,
    candidates: `SELECT t.id FROM stock_sync_proposals t
      WHERE t.created_at < now() - make_interval(days => $1::int)
        AND t.status NOT IN ('PROPOSED', 'APPROVED')
        AND NOT EXISTS (SELECT 1 FROM stock_sync_jobs j WHERE j.proposal_id = t.id)
        AND t.id NOT IN (SELECT max(id) FROM stock_sync_proposals GROUP BY pool_key)
        AND t.id NOT IN (SELECT max(id) FROM stock_sync_proposals WHERE stock_model IS NOT NULL AND stock_model <> 'UNKNOWN' GROUP BY pool_key)`,
  },
  {
    table: "price_sync_proposals",
    days: RETENTION_DAYS.priceSyncProposals,
    candidates: `SELECT t.id FROM price_sync_proposals t
      WHERE t.created_at < now() - make_interval(days => $1::int)
        AND t.applied_at IS NULL
        AND t.status NOT IN ('PROPOSED', 'APPLYING')
        AND t.id NOT IN (SELECT max(id) FROM price_sync_proposals GROUP BY marketplace_item_id)`,
  },
];

export interface RetentionResult {
  ran: boolean;
  deleted: Record<string, number>;
  complete: boolean;
}

/**
 * Apaga em lotes de 10 mil (mais antigos primeiro) até acabar ou até o prazo. Roda no máximo uma vez por hora,
 * salvo `force`; a primeira limpeza grande termina ao longo de alguns ticks.
 */
export async function pruneSyncHistory(sql: Sql, opts: { deadline: number; force?: boolean; now?: Date }): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  if (!opts.force) {
    const [last] = await sql.query<{ at: string | null; complete: boolean | null }>(
      `SELECT value->>'at' AS at, (value->>'complete')::boolean AS complete FROM app_settings WHERE key = $1`,
      [LAST_RUN_KEY],
    );
    // Limpeza incompleta (faltou tempo) continua no próximo tick; completa, só depois de 1 h.
    if (last?.at && last.complete !== false && now.getTime() - new Date(last.at).getTime() < MIN_INTERVAL_MS) return { ran: false, deleted: {}, complete: true };
  }
  const deleted: Record<string, number> = {};
  let complete = true;
  for (const rule of RULES) {
    deleted[rule.table] = 0;
    for (;;) {
      if (Date.now() > opts.deadline - 2_000) {
        complete = false;
        break;
      }
      const n = await sql.execute(`DELETE FROM ${rule.table} WHERE id IN (${rule.candidates} ORDER BY t.id LIMIT ${BATCH})`, [rule.days]);
      deleted[rule.table] += n;
      if (n < BATCH) break;
    }
    if (!complete) break;
  }
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [LAST_RUN_KEY, JSON.stringify({ at: now.toISOString(), complete, deleted })],
  );
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total) logger.warn("Retenção do histórico de sincronização", { deleted, complete });
  return { ran: true, deleted, complete };
}
