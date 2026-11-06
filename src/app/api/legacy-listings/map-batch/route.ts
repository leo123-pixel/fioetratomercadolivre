import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getAdminSession } from "@/lib/auth/admin";
import { jsonNoStore } from "@/lib/http";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { confirmBatch } from "@/lib/stock/links";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  items: z
    .array(z.object({ id: z.string().regex(/^\d{1,18}$/), productId: z.number().int().positive() }))
    .min(1)
    .max(100),
  confirm: z.literal(true),
});

/** Vinculação em lote — somente correspondências inequívocas (SKU/GTIN, candidato único) confirmadas pelo operador. */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    return jsonNoStore(await confirmBatch(getSql(), b.data.items, requesterFromSession(getAdminSession(req)?.sid)));
  },
  { mutating: true, rateLimitPerMinute: 10 },
);
