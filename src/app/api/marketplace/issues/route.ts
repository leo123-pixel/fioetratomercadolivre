import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ open: z.enum(["true", "false"]).default("true"), limit: z.coerce.number().int().min(1).max(500).default(200) });

/** Divergências de reconciliação (abertas por padrão). */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const items = await getSql().query(
      `SELECT r.id::text AS id, r.marketplace_item_id AS "itemId", r.listing_id AS "listingId", r.issue_type AS "issueType",
              r.local_value AS "localValue", r.remote_value AS "remoteValue", r.details, r.first_detected_at AS "firstDetectedAt",
              r.last_detected_at AS "lastDetectedAt", r.resolved_at AS "resolvedAt", r.resolution,
              l.listing_draft_id AS "draftId", l.ads_product_id AS "adsProductId"
       FROM marketplace_reconciliation_issues r LEFT JOIN marketplace_listings l ON l.id = r.listing_id
       WHERE ($1::boolean AND r.resolved_at IS NULL) OR (NOT $1::boolean AND r.resolved_at IS NOT NULL)
       ORDER BY r.last_detected_at DESC LIMIT $2::int`,
      [q.data.open === "true", q.data.limit],
    );
    return jsonNoStore({ items });
  },
  { rateLimitPerMinute: 60 },
);
