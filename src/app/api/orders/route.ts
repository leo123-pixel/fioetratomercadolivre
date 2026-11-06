import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { ADS_VIEW_STATUSES, listOrders } from "@/lib/marketplace/orders";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  adsStatus: z.enum(ADS_VIEW_STATUSES).optional(),
  mapping: z.enum(["PENDING", "MAPPED", "PARTIAL", "UNMAPPED"]).optional(),
  q: z.string().max(60).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Pedidos recebidos do Mercado Livre (dados mínimos do comprador). */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    return jsonNoStore(await listOrders(getSql(), q.data));
  },
  { rateLimitPerMinute: 120 },
);
