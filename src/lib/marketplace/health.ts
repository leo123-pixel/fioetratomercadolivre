import "server-only";
import { getConnectionSummary } from "../meli/connection";
import type { Sql } from "../sql";
import { getMarketplaceConfig } from "./config";
import { SUPPORTED_TOPICS } from "./events";

/**
 * Indicadores operacionais para o painel de monitoramento e para a página de anúncios.
 * Tudo é lido do banco local (nenhuma chamada ao ML); a conectividade real é verificada à parte,
 * pelo botão de teste (/users/me), porque credencial guardada não prova conexão ativa.
 */
export interface MonitoringSummary {
  generatedAt: string;
  connection: Awaited<ReturnType<typeof getConnectionSummary>>;
  events: {
    byStatus: Record<string, number>;
    last24h: Record<string, number>;
    lastReceivedAt: string | null;
    lastWebhookAt: string | null;
    lastProcessedAt: string | null;
    oldestPendingAt: string | null;
    avgProcessingMs24h: number | null;
    avgDelayMs24h: number | null;
    authFailures24h: number;
    apiErrors24h: number;
    topics: { topic: string; total: number; last: string | null }[];
  };
  jobs: { type: string; status: string; trigger: string; startedAt: string; finishedAt: string | null; processed: number; changed: number; failed: number; error: string | null }[];
  lastSuccessfulApiAt: string | null;
  listings: { monitored: number; current: number; lastSyncedAt: string | null; withSyncError: number };
  divergences: Record<string, number>;
  scheduler: { lastTickAt: string | null; lastTickTrigger: string | null; registered: boolean; pgCron: "active" | "missing" | "unknown"; intervals: Record<string, number> };
  orders: { total: number; byAdsStatus: Record<string, number> };
  lastAlert: { code: string; message: string; at: string } | null;
  supportedTopics: string[];
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function getMonitoringSummary(sql: Sql): Promise<MonitoringSummary> {
  const [byStatus, last24h, ev, topics, jobs, listings, divergences, settings, orders, cron] = await Promise.all([
    sql.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM marketplace_webhook_events GROUP BY status`),
    sql.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM marketplace_webhook_events WHERE received_at > now() - interval '24 hours' GROUP BY status`),
    sql.query<Record<string, unknown>>(
      `SELECT max(received_at) AS "lastReceivedAt",
              max(received_at) FILTER (WHERE source = 'webhook') AS "lastWebhookAt",
              max(processed_at) FILTER (WHERE status = 'COMPLETED') AS "lastProcessedAt",
              min(received_at) FILTER (WHERE status IN ('PENDING', 'RETRYING', 'PROCESSING')) AS "oldestPendingAt",
              (avg(duration_ms) FILTER (WHERE status = 'COMPLETED' AND received_at > now() - interval '24 hours'))::int AS "avgProcessingMs24h",
              (avg(EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000) FILTER (WHERE status = 'COMPLETED' AND coalesced_into IS NULL
                 AND received_at > now() - interval '24 hours'))::int AS "avgDelayMs24h",
              (SELECT count(*)::int FROM marketplace_event_processing_errors WHERE created_at > now() - interval '24 hours' AND error_code LIKE 'auth%') AS "authFailures24h",
              (SELECT count(*)::int FROM marketplace_event_processing_errors WHERE created_at > now() - interval '24 hours') AS "apiErrors24h"
       FROM marketplace_webhook_events`,
    ),
    sql.query<{ topic: string; total: number; last: Date | null }>(
      `SELECT topic, count(*)::int AS total, max(received_at) AS last FROM marketplace_webhook_events GROUP BY topic ORDER BY total DESC LIMIT 30`,
    ),
    sql.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (type) type, status, trigger, started_at AS "startedAt", finished_at AS "finishedAt", total_processed AS processed,
              total_changed AS changed, total_failed AS failed, error_message AS error
       FROM marketplace_sync_jobs ORDER BY type, started_at DESC`,
    ),
    sql.query<Record<string, unknown>>(
      `SELECT count(*)::int AS monitored, count(*) FILTER (WHERE status NOT IN ('closed', 'deleted'))::int AS current,
              max(last_synced_at) AS "lastSyncedAt", count(*) FILTER (WHERE sync_error_at IS NOT NULL)::int AS "withSyncError"
       FROM marketplace_listings`,
    ),
    sql.query<{ type: string; n: number }>(`SELECT issue_type AS type, count(*)::int AS n FROM marketplace_reconciliation_issues WHERE resolved_at IS NULL GROUP BY 1`),
    sql.query<{ key: string; value: Record<string, unknown>; updatedAt: Date }>(
      `SELECT key, value, updated_at AS "updatedAt" FROM app_settings WHERE key IN ('meli_scheduler', 'meli_scheduler_last_tick', 'meli_last_alert')`,
    ),
    sql.query<{ status: string; n: number }>(`SELECT ads_import_status AS status, count(*)::int AS n FROM marketplace_order_inbox GROUP BY 1`),
    sql
      .query<{ active: boolean | null }>(
        `SELECT CASE WHEN to_regclass('cron.job') IS NULL THEN NULL ELSE true END AS active`,
      )
      .catch(() => [{ active: null }]),
  ]);
  let pgCron: "active" | "missing" | "unknown" = "unknown";
  if (cron[0]?.active === null) pgCron = "missing";
  else {
    try {
      const rows = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'fioetrato-meli-tick' AND active`);
      pgCron = rows[0]?.n ? "active" : "missing";
    } catch {
      pgCron = "unknown";
    }
  }
  const setting = (k: string) => settings.find((s) => s.key === k);
  const tick = setting("meli_scheduler_last_tick");
  const alert = setting("meli_last_alert")?.value as { code?: string; message?: string; at?: string } | undefined;
  const e = ev[0] ?? {};
  const lastJobOk = jobs.filter((j) => j.status === "COMPLETED" || j.status === "PARTIAL").map((j) => j.finishedAt as Date | null);
  const lastSuccessfulApiAt = [e.lastProcessedAt as Date | null, ...lastJobOk].filter(Boolean).map((d) => new Date(d as Date).getTime()).sort((a, b) => b - a)[0];
  const cfg = getMarketplaceConfig();
  const l = listings[0] ?? {};
  return {
    generatedAt: new Date().toISOString(),
    connection: await getConnectionSummary(),
    events: {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      last24h: Object.fromEntries(last24h.map((r) => [r.status, r.n])),
      lastReceivedAt: iso(e.lastReceivedAt),
      lastWebhookAt: iso(e.lastWebhookAt),
      lastProcessedAt: iso(e.lastProcessedAt),
      oldestPendingAt: iso(e.oldestPendingAt),
      avgProcessingMs24h: (e.avgProcessingMs24h as number | null) ?? null,
      avgDelayMs24h: (e.avgDelayMs24h as number | null) ?? null,
      authFailures24h: Number(e.authFailures24h ?? 0),
      apiErrors24h: Number(e.apiErrors24h ?? 0),
      topics: topics.map((t) => ({ topic: t.topic, total: t.total, last: iso(t.last) })),
    },
    jobs: jobs.map((j) => ({
      type: String(j.type),
      status: String(j.status),
      trigger: String(j.trigger),
      startedAt: iso(j.startedAt)!,
      finishedAt: iso(j.finishedAt),
      processed: Number(j.processed),
      changed: Number(j.changed),
      failed: Number(j.failed),
      error: (j.error as string | null) ?? null,
    })),
    lastSuccessfulApiAt: lastSuccessfulApiAt ? new Date(lastSuccessfulApiAt).toISOString() : null,
    listings: { monitored: Number(l.monitored ?? 0), current: Number(l.current ?? 0), lastSyncedAt: iso(l.lastSyncedAt), withSyncError: Number(l.withSyncError ?? 0) },
    divergences: Object.fromEntries(divergences.map((d) => [d.type, d.n])),
    scheduler: {
      lastTickAt: tick ? iso(tick.updatedAt) : null,
      lastTickTrigger: (tick?.value?.trigger as string | undefined) ?? null,
      registered: !!setting("meli_scheduler"),
      pgCron,
      intervals: { listingsMin: cfg.listingSyncIntervalMin, missedFeedsMin: cfg.missedFeedsIntervalMin, ordersRecoveryMin: cfg.ordersRecoveryIntervalMin },
    },
    orders: { total: orders.reduce((a, o) => a + o.n, 0), byAdsStatus: Object.fromEntries(orders.map((o) => [o.status, o.n])) },
    lastAlert: alert?.code ? { code: alert.code, message: alert.message ?? "", at: alert.at ?? "" } : null,
    supportedTopics: SUPPORTED_TOPICS,
  };
}

/** Marca de alteração dos dados locais de anúncios (a interface recarrega quando muda). */
export async function listingsChangeMark(sql: Sql): Promise<string> {
  // Só muda quando algo relevante muda (nova fotografia, mudança de status, divergência aberta/resolvida),
  // não a cada leitura sem alteração.
  const [row] = await sql.query<{ a: Date | null; b: Date | null; c: Date | null; d: Date | null; n: number }>(
    `SELECT (SELECT max(fetched_at) FROM marketplace_listing_snapshots) AS a,
            (SELECT max(created_at) FROM marketplace_listing_events) AS b,
            (SELECT max(first_detected_at) FROM marketplace_reconciliation_issues) AS c,
            (SELECT max(resolved_at) FROM marketplace_reconciliation_issues) AS d,
            (SELECT count(*)::int FROM marketplace_listings) AS n`,
  );
  return [row?.a, row?.b, row?.c, row?.d].map((d) => (d ? new Date(d).getTime() : 0)).concat(row?.n ?? 0).join("-");
}
