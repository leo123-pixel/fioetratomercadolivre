import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listingsChangeMark } from "@/lib/marketplace/health";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marca de alteração dos dados LOCAIS de anúncios: a tela recarrega quando muda (não consulta o ML). */
export const GET = adminHandler(async () => jsonNoStore({ mark: await listingsChangeMark(getSql()) }), { rateLimitPerMinute: 120 });
