import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { acquireLease, releaseLease } from "../imports/jobs";
import { getEnv } from "../env";
import { logger } from "../logger";
import { MeliAuthError } from "../meli/tokens";
import { syncAllListings } from "../publish/listings";
import { getSql, type Sql } from "../sql";
import { getStore } from "../store";
import { raiseAlert } from "./alerts";
import { getMarketplaceConfig } from "./config";
import { classifyError } from "./errors";
import { processEvents } from "./events";
import { recoverMissedFeeds } from "./missed-feeds";
import { recoverRecentOrders } from "./orders";

/**
 * Agendamento server-side, independente de navegador aberto:
 *   - Supabase pg_cron (a cada 5 min) → POST /api/marketplace/scheduler/tick com x-scheduler-token
 *     (URL e token gravados pela aplicação em app_settings.meli_scheduler);
 *   - Vercel Cron diário no mesmo endpoint (rede de segurança; exige CRON_SECRET);
 *   - "chute" oportunista quando o painel ou o webhook percebem que o último tick está atrasado.
 * Cada tick: processa a fila de eventos e roda as rotinas periódicas que estiverem vencidas
 * (reconciliação de anúncios, missed_feeds, varredura de pedidos), cada uma com lease próprio.
 */
export const TICK_PATH = "/api/marketplace/scheduler/tick";
export type SyncJobType = "LISTINGS_RECONCILE" | "MISSED_FEEDS" | "ORDERS_RECOVERY";
export type Trigger = "scheduler" | "manual" | "cron";

export function schedulerToken(): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update("meli-scheduler-tick:v1").digest("base64url");
}

export function verifySchedulerToken(candidate: string | null): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(schedulerToken());
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Grava (se mudou) a URL e o token que o pg_cron usa para chamar o tick. */
export async function ensureSchedulerRegistration(sql: Sql): Promise<void> {
  const value = JSON.stringify({ url: new URL(TICK_PATH, getEnv().APP_BASE_URL).toString(), token: schedulerToken() });
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('meli_scheduler', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value`,
    [value],
  );
}

function intervalFor(type: SyncJobType): number {
  const c = getMarketplaceConfig();
  return type === "LISTINGS_RECONCILE" ? c.listingSyncIntervalMin : type === "MISSED_FEEDS" ? c.missedFeedsIntervalMin : c.ordersRecoveryIntervalMin;
}

/** A rotina está vencida? (última execução iniciada há mais que o intervalo). */
export async function isDue(sql: Sql, type: SyncJobType): Promise<boolean> {
  const [row] = await sql.query<{ due: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM marketplace_sync_jobs WHERE type = $1::text
       AND started_at > now() - make_interval(mins => $2::int) - interval '20 seconds') AS due`,
    [type, intervalFor(type)],
  );
  return row?.due === true;
}

export interface SyncJobResult {
  id: string | null;
  type: SyncJobType;
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "BUSY";
  processed: number;
  changed: number;
  failed: number;
  details: Record<string, unknown>;
  error?: string;
}

/** Executa uma rotina periódica registrando-a em marketplace_sync_jobs (com lease contra execuções simultâneas). */
export async function runSyncJob(sql: Sql, type: SyncJobType, trigger: Trigger): Promise<SyncJobResult> {
  const owner = randomUUID();
  const lease = `ml-sync:${type}`;
  if (!(await acquireLease(sql, owner, lease))) return { id: null, type, status: "BUSY", processed: 0, changed: 0, failed: 0, details: {} };
  // Execução anterior que morreu sem finalizar.
  await sql.execute(
    `UPDATE marketplace_sync_jobs SET status = 'FAILED', finished_at = now(), error_message = 'Execução interrompida'
     WHERE type = $1::text AND status = 'RUNNING'`,
    [type],
  );
  const [{ id }] = await sql.query<{ id: string }>(`INSERT INTO marketplace_sync_jobs (type, trigger) VALUES ($1::text, $2::text) RETURNING id::text AS id`, [type, trigger]);
  let result: SyncJobResult;
  try {
    if (type === "LISTINGS_RECONCILE") {
      const r = await syncAllListings(sql, { source: "sync", jobId: id });
      result = { id, type, status: r.failed ? "PARTIAL" : "COMPLETED", processed: r.checked, changed: r.changed, failed: r.failed, details: { ...r } };
    } else if (type === "MISSED_FEEDS") {
      const r = await recoverMissedFeeds(sql);
      const topicFailures = Object.keys(r.topicErrors).length;
      result = { id, type, status: topicFailures ? "PARTIAL" : "COMPLETED", processed: r.fetched, changed: r.stored, failed: topicFailures, details: { ...r } };
    } else {
      const r = await recoverRecentOrders(sql);
      result = { id, type, status: "COMPLETED", processed: r.checked, changed: r.enqueued, failed: 0, details: { ...r } };
    }
  } catch (err) {
    const c = classifyError(err);
    result = { id, type, status: "FAILED", processed: 0, changed: 0, failed: 1, details: { code: c.code, auth: c.auth }, error: c.message };
    logger.error("Rotina periódica do Mercado Livre falhou", { type, jobId: id, code: c.code });
    if (c.auth || err instanceof MeliAuthError) await raiseAlert(sql, "meli_auth_failure", `Falha de autenticação no Mercado Livre durante ${type}: ${c.code}`, { type });
    else await raiseAlert(sql, `sync_failed:${type}`, `Rotina ${type} falhou: ${c.message}`, { type });
  } finally {
    await releaseLease(sql, owner, lease).catch(() => undefined);
  }
  await sql.execute(
    `UPDATE marketplace_sync_jobs SET status = $2::text, finished_at = now(), total_processed = $3::int, total_changed = $4::int,
       total_failed = $5::int, details = $6::jsonb, error_message = $7::text WHERE id = $1::uuid`,
    [id, result.status, result.processed, result.changed, result.failed, JSON.stringify(result.details), result.error ?? null],
  );
  return result;
}

/** Limpeza: JSON original de pedidos expirado (LGPD) e eventos antigos já concluídos. */
async function housekeeping(sql: Sql): Promise<void> {
  const cfg = getMarketplaceConfig();
  await sql.execute(`DELETE FROM marketplace_order_raw WHERE expires_at < now()`);
  await sql.execute(
    `DELETE FROM marketplace_webhook_events WHERE status IN ('COMPLETED', 'IGNORED') AND received_at < now() - make_interval(days => $1::int)`,
    [cfg.eventRetentionDays],
  );
}

async function checkBacklog(sql: Sql): Promise<void> {
  const mins = getMarketplaceConfig().backlogAlertMinutes;
  const [row] = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM marketplace_webhook_events
     WHERE status IN ('PENDING', 'RETRYING', 'PROCESSING') AND received_at < now() - make_interval(mins => $1::int)`,
    [mins],
  );
  if (row && row.n > 0) await raiseAlert(sql, "event_backlog", `${row.n} evento(s) do Mercado Livre aguardando há mais de ${mins} minutos`, { count: row.n });
}

export interface TickResult {
  events: { processed: number; byStatus: Record<string, number> };
  jobs: SyncJobResult[];
}

export async function runTick(sql: Sql, trigger: Trigger): Promise<TickResult> {
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('meli_scheduler_last_tick', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ trigger, at: new Date().toISOString() })],
  );
  await ensureSchedulerRegistration(sql).catch((err) => logger.warn("Falha ao registrar o agendador", { err }));
  const events = await processEvents({ sql, budgetMs: 20_000 });
  const jobs: SyncJobResult[] = [];
  // Sem conta conectada as rotinas não têm o que consultar; os eventos continuam guardados.
  const conn = await getStore().getCurrentConnection();
  const connected = conn?.status === "ACTIVE" && !!conn.refreshTokenEnc;
  for (const type of ["LISTINGS_RECONCILE", "ORDERS_RECOVERY", "MISSED_FEEDS"] as SyncJobType[]) {
    if (connected && (await isDue(sql, type))) jobs.push(await runSyncJob(sql, type, trigger));
  }
  // Eventos gerados pelas rotinas (missed_feeds, pedidos recuperados) já entram nesta execução.
  if (jobs.some((j) => j.changed > 0 && j.type !== "LISTINGS_RECONCILE")) {
    const more = await processEvents({ sql, budgetMs: 15_000 });
    events.processed += more.processed;
  }
  await housekeeping(sql).catch((err) => logger.warn("Falha na limpeza periódica", { err }));
  await checkBacklog(sql).catch(() => undefined);
  return { events: { processed: events.processed, byStatus: events.byStatus }, jobs };
}

let tickRunner: (trigger: Trigger) => void = (trigger) =>
  after(() =>
    runTick(getSql(), trigger).then(
      () => undefined,
      (err) => logger.error("Erro no tick do agendador", { err }),
    ),
  );

/** Agenda um tick para depois da resposta HTTP atual. */
export function scheduleTick(trigger: Trigger): void {
  tickRunner(trigger);
}

/** Se o agendador externo não roda há mais de 10 minutos, executa um tick depois da resposta. */
export async function kickIfStale(sql: Sql): Promise<boolean> {
  try {
    const [row] = await sql.query<{ stale: boolean }>(
      `SELECT COALESCE((SELECT updated_at < now() - interval '10 minutes' FROM app_settings WHERE key = 'meli_scheduler_last_tick'), true) AS stale`,
    );
    if (!row?.stale) return false;
    // Marca antes para que várias visualizações simultâneas não disparem vários ticks.
    await sql.execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('meli_scheduler_last_tick', '{"trigger":"kick"}'::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
    scheduleTick("scheduler");
    return true;
  } catch (err) {
    logger.warn("Falha ao verificar o agendador", { err });
    return false;
  }
}

/** Somente testes. */
export function setTickRunnerForTesting(fn: ((trigger: Trigger) => void) | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setTickRunnerForTesting só pode ser usado em testes");
  tickRunner =
    fn ??
    ((trigger) =>
      after(() =>
        runTick(getSql(), trigger).then(
          () => undefined,
          (err) => logger.error("Erro no tick do agendador", { err }),
        ),
      ));
}
