import { z } from "zod";
import { HHMM } from "@/lib/ads/hours";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { autoSyncState, envAutoSyncAllowed, getStockSettings, updateStockSettings } from "@/lib/stock/settings";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function view() {
  const settings = await getStockSettings(getSql());
  return { settings, envAutoSyncAllowed: envAutoSyncAllowed(), autoSync: autoSyncState(settings) };
}

export const GET = adminHandler(async () => jsonNoStore(await view()), { rateLimitPerMinute: 120 });

const body = z
  .object({
    autoSyncEnabled: z.boolean().optional(),
    autoSyncIntervalMin: z.number().int().min(15).max(1440).optional(),
    autoSyncScope: z.enum(["ALL_LINKED", "APPROVED_GROUPS"]).optional(),
    adsHoursStart: z.string().regex(HHMM, "Use o formato HH:MM").nullable().optional(),
    adsHoursEnd: z.string().regex(HHMM, "Use o formato HH:MM").nullable().optional(),
    maxStockAgeMinutes: z.number().int().min(1).max(240).optional(),
    defaultSafetyReserve: z.number().int().min(0).max(100_000).optional(),
    branchIds: z.array(z.string().trim().min(1).max(20)).max(50).nullable().optional(),
    pendingOrderWindowDays: z.number().int().min(1).max(60).optional(),
    maxJobsPerRun: z.number().int().min(1).max(200).optional(),
    stockSourceConfirmed: z.boolean().optional(),
    homologate: z.literal(true).optional(),
  })
  .strict();

/** Alterações registradas na auditoria. Ativar a automação exige ambiente, confirmação da origem e homologação. */
export const PATCH = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    await updateStockSettings(getSql(), b.data, requesterFromSession(getAdminSession(req)?.sid));
    return jsonNoStore(await view());
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
