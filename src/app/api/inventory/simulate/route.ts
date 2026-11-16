import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { AllocationInvariantError, planQuotas, worstCaseExposure, type ChannelExposure, type ChannelRule } from "@/lib/inventory/allocation";
import { computePosition, type SnapshotInput } from "@/lib/inventory/position";
import type { ReservationState } from "@/lib/inventory/reservations";
import { getInventorySettings, ruleSchema } from "@/lib/inventory/settings";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES = ["PENDING_ERP", "REFLECTED_IN_ERP", "RELEASED", "REQUIRES_RECONCILIATION"] as const;
const body = z
  .object({
    /** Parte dos valores reais de um pool (os campos informados substituem). */
    poolId: z.string().regex(/^\d{1,18}$/).optional(),
    adsStatus: z.enum(["KNOWN", "UNKNOWN", "ERROR"]).optional(),
    adsQuantity: z.number().min(-1_000_000).max(1_000_000).nullable().optional(),
    safetyReserve: z.number().int().min(0).max(1_000_000).optional(),
    reservations: z.array(z.object({ quantity: z.number().positive().max(1_000_000), state: z.enum(STATES) }).strict()).max(200).optional(),
    rules: z.array(ruleSchema).min(1).max(10),
    remainderMode: z.enum(["PRIORITY", "UNALLOCATED"]).default("PRIORITY"),
    /** Quantidade anunciada atual por canal (null = desconhecida). Canais sem valor: 0. */
    confirmed: z.record(z.string().regex(/^[a-z0-9_]{2,30}$/), z.number().int().min(0).max(1_000_000).nullable()).optional(),
    allowIncrease: z.boolean().optional(),
  })
  .strict();

/**
 * SIMULADOR de cotas: cálculo puro, nada é gravado nem publicado. Pode partir de um pool real
 * (saldo ADS, compromissos e quantidade anunciada) e alterar política, saldo, reservas e exposição.
 */
export const POST = adminHandler(
  async (req) => {
    const b = await parseJsonBody(req, body);
    if (!b.ok) return b.response;
    const sql = getSql();
    const settings = await getInventorySettings(sql);
    let snapshot: SnapshotInput = { status: "UNKNOWN", quantity: null, fetchedAt: new Date() };
    let reserve = 0;
    let reservations: { quantity: number | string; state: ReservationState }[] = [];
    const confirmed: Record<string, number | null> = {};
    let source: Record<string, unknown> | null = null;
    if (b.data.poolId) {
      const [pool] = await sql.query<{ poolKey: string; adsStatus: SnapshotInput["status"]; adsQuantity: string | null; adsFetchedAt: Date | null; safetyReserve: number }>(
        `SELECT pool_key AS "poolKey", ads_status AS "adsStatus", trim_scale(ads_quantity)::text AS "adsQuantity", ads_fetched_at AS "adsFetchedAt", safety_reserve AS "safetyReserve"
         FROM inventory_pools WHERE id = $1::bigint`,
        [b.data.poolId],
      );
      if (!pool) return errorJson(404, "pool_not_found", "Pool não encontrado");
      snapshot = { status: pool.adsStatus, quantity: pool.adsQuantity, fetchedAt: pool.adsFetchedAt ? new Date(pool.adsFetchedAt) : null };
      reserve = pool.safetyReserve;
      reservations = await sql.query(`SELECT trim_scale(quantity)::text AS quantity, state FROM inventory_reservations WHERE pool_id = $1::bigint AND NOT simulated`, [b.data.poolId]);
      for (const a of await sql.query<{ channel: string; confirmed: number | null; simulated: boolean }>(
        `SELECT channel, confirmed_quantity AS confirmed, simulated FROM inventory_channel_allocations WHERE pool_id = $1::bigint`,
        [b.data.poolId],
      )) {
        confirmed[a.channel] = a.simulated ? 0 : a.confirmed;
      }
      source = { poolId: b.data.poolId, poolKey: pool.poolKey };
    }
    if (b.data.adsStatus || b.data.adsQuantity !== undefined) {
      const status = b.data.adsStatus ?? (b.data.adsQuantity === null ? "UNKNOWN" : "KNOWN");
      snapshot = { status, quantity: status === "KNOWN" ? (b.data.adsQuantity ?? null) : null, fetchedAt: new Date() };
    }
    if (b.data.safetyReserve !== undefined) reserve = b.data.safetyReserve;
    if (b.data.reservations) reservations = b.data.reservations;
    Object.assign(confirmed, b.data.confirmed ?? {});
    const position = computePosition({ snapshot, reservations, safetyReserve: reserve, maxSnapshotAgeMinutes: settings.maxSnapshotAgeMinutes });
    const rules = b.data.rules as ChannelRule[];
    const exposures: ChannelExposure[] = rules.map((r) => ({
      channel: r.channel,
      confirmed: r.channel in confirmed ? confirmed[r.channel] : 0,
      reachable: r.channel === "mercadolivre",
      simulated: r.channel !== "mercadolivre",
    }));
    try {
      const plan = planQuotas(position.safeSellable, { rules, remainderMode: b.data.remainderMode }, exposures, { allowIncrease: b.data.allowIncrease ?? position.allowIncrease });
      return jsonNoStore({
        simulated: true,
        notice: "Simulação: nenhum valor foi gravado nem publicado em canal algum",
        source,
        position,
        allocation: plan.allocation,
        plan: plan.items,
        worstCaseExposure: worstCaseExposure(plan),
        overExposedBy: plan.overExposedBy,
      });
    } catch (err) {
      if (err instanceof AllocationInvariantError) return errorJson(422, "invalid_policy", err.message);
      throw err;
    }
  },
  { mutating: true, rateLimitPerMinute: 60 },
);
