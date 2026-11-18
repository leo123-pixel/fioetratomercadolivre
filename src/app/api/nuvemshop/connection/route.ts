import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { checkConnection, connectionView } from "@/lib/nuvemshop/connection";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/nuvemshop/connection — situação da conexão (sem token). */
export const GET = adminHandler(async () => jsonNoStore(await connectionView(getSql())));

/** POST /api/nuvemshop/connection — valida a conexão com consultas reais (GET /store e GET /locations). */
export const POST = adminHandler(async () => jsonNoStore(await checkConnection(getSql())), { mutating: true, rateLimitPerMinute: 10 });
