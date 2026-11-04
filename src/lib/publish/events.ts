import "server-only";
import type { Sql } from "../sql";

/** Registra um evento de auditoria do rascunho/anúncio. */
export async function recordEvent(
  sql: Sql,
  e: { draftId: number; type: string; from?: string | null; to?: string | null; listingId?: number | null; jobId?: string | null; details?: unknown },
): Promise<void> {
  await sql.execute(
    `INSERT INTO marketplace_listing_events (listing_draft_id, listing_id, job_id, event_type, previous_status, new_status, details)
     VALUES ($1::int, $2::int, $3::uuid, $4::text, $5::text, $6::text, $7::jsonb)`,
    [e.draftId, e.listingId ?? null, e.jobId ?? null, e.type, e.from ?? null, e.to ?? null, e.details === undefined ? null : JSON.stringify(e.details)],
  );
}

export async function listEvents(sql: Sql, draftId: number, limit = 100) {
  return sql.query<{ id: string; eventType: string; previousStatus: string | null; newStatus: string | null; jobId: string | null; details: unknown; createdAt: Date }>(
    `SELECT id::text AS id, event_type AS "eventType", previous_status AS "previousStatus", new_status AS "newStatus",
            job_id::text AS "jobId", details, created_at AS "createdAt"
     FROM marketplace_listing_events WHERE listing_draft_id = $1::int ORDER BY id DESC LIMIT $2::int`,
    [draftId, limit],
  );
}
