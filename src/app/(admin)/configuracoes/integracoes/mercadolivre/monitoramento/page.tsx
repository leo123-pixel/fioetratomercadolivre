import { requireAdminPage } from "@/lib/auth/page-guard";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { listEvents } from "@/lib/marketplace/events";
import { getMonitoringSummary } from "@/lib/marketplace/health";
import { ensureSchedulerRegistration, kickIfStale } from "@/lib/marketplace/scheduler";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../../../PageProblem";
import { MonitoringPanel } from "./MonitoringPanel";

export const dynamic = "force-dynamic";

const PATH = "/configuracoes/integracoes/mercadolivre/monitoramento";
const STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "RETRYING", "IGNORED"];

export default async function MonitoramentoPage({ searchParams }: { searchParams: Promise<{ status?: string; topic?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage(PATH)) === "config") return <PageProblem kind="config" />;
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : undefined;
  const topic = sp.topic && /^[a-z0-9_-]{1,60}$/i.test(sp.topic) ? sp.topic : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  let summary, events, issues, jobs;
  try {
    const sql = getSql();
    await ensureSchedulerRegistration(sql);
    await kickIfStale(sql);
    [summary, events, issues, jobs] = await Promise.all([
      getMonitoringSummary(sql),
      listEvents(sql, { status, topic, page, pageSize: 50 }),
      sql.query(
        `SELECT r.id::text AS id, r.marketplace_item_id AS "itemId", r.issue_type AS "issueType", r.local_value AS "localValue",
                r.remote_value AS "remoteValue", r.details, r.first_detected_at AS "firstDetectedAt", r.last_detected_at AS "lastDetectedAt",
                l.listing_draft_id AS "draftId"
         FROM marketplace_reconciliation_issues r LEFT JOIN marketplace_listings l ON l.id = r.listing_id
         WHERE r.resolved_at IS NULL ORDER BY r.last_detected_at DESC LIMIT 100`,
      ),
      sql.query(
        `SELECT id::text AS id, type, trigger, status, started_at AS "startedAt", finished_at AS "finishedAt", total_processed AS processed,
                total_changed AS changed, total_failed AS failed, error_message AS error
         FROM marketplace_sync_jobs ORDER BY started_at DESC LIMIT 20`,
      ),
    ]);
  } catch (err) {
    logger.error("Falha ao carregar o monitoramento", { err });
    return <PageProblem kind="database" />;
  }
  const webhookUrl = new URL("/api/webhooks/mercadolivre", getEnv().APP_BASE_URL).toString();
  return (
    <>
      <p className="breadcrumb">
        Configurações › Integrações › <a href="/configuracoes/integracoes/mercadolivre">Mercado Livre</a> › Monitoramento
      </p>
      <div className="page-head">
        <h1>Monitoramento da integração</h1>
        <span className="muted">Somente leitura no Mercado Livre · nenhum pedido é enviado à ADS nesta fase</span>
      </div>
      <MonitoringPanel
        summary={JSON.parse(JSON.stringify(summary))}
        events={JSON.parse(JSON.stringify(events))}
        issues={JSON.parse(JSON.stringify(issues))}
        jobs={JSON.parse(JSON.stringify(jobs))}
        filters={{ status: status ?? "", topic: topic ?? "" }}
        webhookUrl={webhookUrl}
      />
    </>
  );
}
