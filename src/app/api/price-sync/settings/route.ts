import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { autoPriceState, getPriceSettings, updatePriceSettings } from "@/lib/stock/prices";
import { envAutoSyncAllowed } from "@/lib/stock/settings";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function view() {
  const settings = await getPriceSettings(getSql());
  return { settings, envAutoSyncAllowed: envAutoSyncAllowed(), autoSync: autoPriceState(settings) };
}

export const GET = adminHandler(async () => jsonNoStore(await view()), { rateLimitPerMinute: 120 });

const body = z
  .object({
    autoSyncEnabled: z.boolean().optional(),
    autoSyncIntervalMin: z.number().int().min(15).max(1440).optional(),
    autoApplyLargeChanges: z.boolean().optional(),
  })
  .strict();

/** Liga/desliga a atualização automática de preço (registrada na auditoria). */
export const PATCH = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    await updatePriceSettings(getSql(), b.data, requesterFromSession(getAdminSession(req)?.sid));
    return jsonNoStore(await view());
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
