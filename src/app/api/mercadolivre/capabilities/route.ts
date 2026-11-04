import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getCapabilities } from "@/lib/meli/capabilities";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Capacidades da conta conectada (modelo User Products, escopo de escrita, token). ?refresh=1 força nova consulta. */
export const GET = adminHandler(
  async (req) => jsonNoStore({ capabilities: await getCapabilities(getSql(), { refresh: req.nextUrl.searchParams.get("refresh") === "1" }) }),
  { rateLimitPerMinute: 20 },
);
