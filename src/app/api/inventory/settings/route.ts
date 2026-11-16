import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { inventoryCoreMode } from "@/lib/inventory/mode";
import { getInventorySettings, settingsPatchSchema, updateInventorySettings } from "@/lib/inventory/settings";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";
import { actorOf } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(async () => jsonNoStore({ mode: inventoryCoreMode(), settings: await getInventorySettings(getSql()) }));

export const PATCH = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, settingsPatchSchema);
    if (!b.ok) return b.response;
    return jsonNoStore({ settings: await updateInventorySettings(getSql(), b.data, actorOf(req)) });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
