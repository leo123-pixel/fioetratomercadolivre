import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { listTransfers, simulateQuotaTransfer } from "@/lib/inventory/transfer-service";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";
import { actorOf } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const outcome = z.enum(["confirmed", "failed", "uncertain"]);
const body = z
  .object({
    poolId: z.string().regex(/^\d{1,18}$/),
    fromChannel: z.string().regex(/^[a-z0-9_]{2,30}$/),
    toChannel: z.string().regex(/^[a-z0-9_]{2,30}$/),
    quantity: z.number().int().positive().max(1_000_000),
    outcomes: z.object({ sourceDecrease: outcome.optional(), destinationIncrease: outcome.optional() }).strict().optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/).optional(),
  })
  .strict();

export const GET = adminHandler(async () => jsonNoStore({ transfers: await listTransfers(getSql(), 50) }));

/** Simula o protocolo seguro de transferência de cota (fase 0: sem chamadas remotas; cotas reais intactas). */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    return jsonNoStore({ transfer: await simulateQuotaTransfer(getSql(), { ...b.data, requestedBy: actorOf(req) }) });
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
