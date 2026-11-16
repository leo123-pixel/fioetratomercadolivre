import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { getOverview } from "@/lib/inventory/queries";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resumo do Inventory Core: modo (sempre sem escrita remota), pools, divergências, compromissos e última execução. */
export const GET = adminHandler(async () => jsonNoStore(await getOverview(getSql())));
