import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getMonitoringSummary } from "@/lib/marketplace/health";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Indicadores de saúde da integração (somente dados locais). */
export const GET = adminHandler(async () => jsonNoStore(await getMonitoringSummary(getSql())), { rateLimitPerMinute: 60 });
