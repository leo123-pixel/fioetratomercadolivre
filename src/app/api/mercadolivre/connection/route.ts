import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getConnectionSummary } from "@/lib/meli/connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/mercadolivre/connection — status da conexão, sem nenhuma credencial. */
export const GET = adminHandler(async () => jsonNoStore(await getConnectionSummary()));
