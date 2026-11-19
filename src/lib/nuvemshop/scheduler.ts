import "server-only";
import { randomUUID } from "node:crypto";
import { acquireLease, releaseLease } from "../imports/jobs";
import { logger } from "../logger";
import { raiseAlert } from "../marketplace/alerts";
import type { Sql } from "../sql";
import { getAutomation, isRunDue } from "./automation";
import { processWebhookEvents } from "./events";
import { createImportJob, nuvemshopNeedsWorker, processNuvemshopJobs } from "./import";
import { getOrderCursor, reconcileOrders } from "./orders";
import { runPriceSync } from "./price-sync";
import { runStockSync } from "./stock-sync";
import { clientForConnectedStore, getConnectedStore } from "./store";
import { hasScope } from "./write-gate";
import { processWriteJobs, resolveUncertainJobs, type WorkerDeps } from "./write-jobs";

/**
 * Ciclo da Nuvemshop dentro do tick do agendador server-side (pg_cron a cada 5 min → /api/marketplace/scheduler/tick).
 * Não depende de painel aberto nem de setInterval no processo web. Cada etapa tem lease/fila própria e falha
 * isolada (uma etapa que falha não impede as outras).
 *
 *   1. fila de webhooks (pedidos e produtos);
 *   2. reconciliação de pedidos (a cada orderReconcileMinutes) — rede de segurança dos webhooks;
 *   3. conferência de escritas incertas (por leitura);
 *   4. preço e estoque, quando vencidos e em SHADOW/PILOT/AUTOMATIC;
 *   5. worker de escritas;
 *   6. importação incremental do catálogo a cada 6 h e a fila de importação;
 *   7. batimento cardíaco e alertas (fila atrasada, falhas).
 */
const TICK_LEASE = "nuvemshop-tick";
const CATALOG_REFRESH_HOURS = 6;

export interface NuvemshopTickResult {
  ran: boolean;
  steps: Record<string, unknown>;
}

export async function runNuvemshopTick(sql: Sql, deadline: number, deps: WorkerDeps = {}): Promise<NuvemshopTickResult> {
  const store = await getConnectedStore(sql);
  if (!store || store.connectionStatus !== "ACTIVE") return { ran: false, steps: { reason: "loja não conectada" } };
  const owner = randomUUID();
  if (!(await acquireLease(sql, owner, TICK_LEASE))) return { ran: false, steps: { reason: "ciclo Nuvemshop já em andamento" } };
  const steps: Record<string, unknown> = {};
  const left = () => deadline - Date.now();
  const step = async (name: string, minMs: number, fn: () => Promise<unknown>) => {
    if (left() < minMs) {
      steps[name] = "sem tempo";
      return;
    }
    try {
      steps[name] = await fn();
    } catch (err) {
      steps[name] = { error: (err as Error).message?.slice(0, 200) };
      logger.error(`Nuvemshop: etapa ${name} falhou`, { err });
    }
  };
  try {
    let conn: WorkerDeps["client"];
    const getConn = async () => (conn ??= deps.client ?? (await clientForConnectedStore(sql, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, maxRetries: deps.maxRetries })));
    await step("webhooks", 8_000, async () => processWebhookEvents(sql, { deadline: Math.min(deadline, Date.now() + 20_000), deps: { ...deps, client: await getConn() } }));
    await step("orders", 10_000, async () => {
      if (!hasScope(store.grantedScopes, "read_orders", "write_orders")) return "sem escopo read_orders";
      const policy = (await getAutomation(sql, "STOCK")).policy;
      const cursor = await getOrderCursor(sql);
      if (cursor.lastRunAt && Date.now() - new Date(cursor.lastRunAt).getTime() < policy.orderReconcileMinutes * 60_000 - 20_000) return "não vencida";
      return reconcileOrders(sql, (await getConn()).client, store.storeId, { deadline: Math.min(deadline, Date.now() + 30_000) });
    });
    await step("uncertain", 8_000, async () => resolveUncertainJobs(sql, { ...deps, client: await getConn() }));
    await step("price", 25_000, async () => ((await isRunDue(sql, "PRICE")) ? runPriceSync(sql, { trigger: "scheduler", requestedBy: "system:nuvemshop-auto", deadline: Math.min(deadline, Date.now() + 45_000), deps: { ...deps, client: await getConn() } }) : "não vencida"));
    await step("stock", 25_000, async () => ((await isRunDue(sql, "STOCK")) ? runStockSync(sql, { trigger: "scheduler", requestedBy: "system:nuvemshop-auto", deadline: Math.min(deadline, Date.now() + 50_000), deps: { ...deps, client: await getConn() } }) : "não vencida"));
    await step("writer", 10_000, async () => processWriteJobs(sql, { deadline: Math.min(deadline, Date.now() + 40_000), deps: { ...deps, client: await getConn() } }));
    await step("catalog", 12_000, async () => {
      const [last] = await sql.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM nuvemshop_catalog_import_jobs WHERE store_id = $1`, [store.storeId]);
      if (!last?.at || Date.now() - new Date(last.at).getTime() > CATALOG_REFRESH_HOURS * 3_600_000) {
        await createImportJob(sql, { mode: last?.at ? "INCREMENTAL" : "FULL", actor: "system:nuvemshop-auto" }).catch(() => undefined);
      }
      if (await nuvemshopNeedsWorker(sql)) return processNuvemshopJobs({ sql, budgetMs: Math.min(30_000, left() - 5_000), fetchImpl: deps.fetchImpl, sleep: deps.sleep });
      return "nada a importar";
    });
    await health(sql);
    await sql.execute(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('nuvemshop_tick_last', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ at: new Date().toISOString(), steps: summarize(steps) })],
    );
    return { ran: true, steps };
  } finally {
    await releaseLease(sql, owner, TICK_LEASE).catch(() => undefined);
  }
}

function summarize(steps: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(steps)) {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      out[k] = o.error ? { error: o.error } : o.status ? { status: o.status, runId: o.runId ?? null } : Object.fromEntries(Object.entries(o).filter(([, x]) => typeof x !== "object").slice(0, 8));
    } else out[k] = v;
  }
  return out;
}

/** Alertas: fila de webhooks atrasada, escritas aguardando reconciliação, falhas recentes. */
async function health(sql: Sql): Promise<void> {
  const [h] = await sql.query<{ backlog: number; reconciliation: number; failed: number }>(
    `SELECT (SELECT count(*) FROM nuvemshop_webhook_events WHERE status IN ('PENDING', 'PROCESSING') AND received_at < now() - interval '15 minutes')::int AS backlog,
            (SELECT count(*) FROM nuvemshop_write_jobs WHERE status = 'REQUIRES_RECONCILIATION')::int AS reconciliation,
            (SELECT count(*) FROM nuvemshop_write_jobs WHERE status = 'FAILED' AND finished_at > now() - interval '1 hour')::int AS failed`,
  );
  if (h?.backlog) await raiseAlert(sql, "nuvemshop_webhook_backlog", `${h.backlog} webhook(s) Nuvemshop aguardando há mais de 15 minutos`);
  if (h?.reconciliation) await raiseAlert(sql, "nuvemshop_jobs_reconciliation", `${h.reconciliation} escrita(s) Nuvemshop aguardando reconciliação manual`);
  if (h && h.failed >= 5) await raiseAlert(sql, "nuvemshop_jobs_failing", `${h.failed} escritas Nuvemshop falharam na última hora`);
}
