import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listLocations, locationPatchSchema, saveLocation } from "@/lib/inventory/settings";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";
import { actorOf } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(async () => jsonNoStore({ locations: await listLocations(getSql()) }));

/** Mapeia uma filial ADS para um depósito (só filiais MAPPED entram no cálculo). */
export const PUT = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, locationPatchSchema);
    if (!b.ok) return b.response;
    return jsonNoStore({ location: await saveLocation(getSql(), b.data, actorOf(req)) });
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
