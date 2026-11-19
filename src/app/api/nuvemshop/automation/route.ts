import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import {
  activateEmergencyStop,
  pauseAutomation,
  releaseEmergencyStop,
  resumeAutomation,
  setAutomationMode,
  setParticipation,
  settingsPatchSchema,
  updateAutomationSettings,
  type AutomationKind,
} from "@/lib/nuvemshop/automation";
import { automationOverview } from "@/lib/nuvemshop/automation-queries";
import { registerWebhooks } from "@/lib/nuvemshop/events";
import { createImportJob } from "@/lib/nuvemshop/import";
import { confirmAdsReflection, reconcileOrders } from "@/lib/nuvemshop/orders";
import { approvePriceReview, priceActivationBlockers, runPriceSync } from "@/lib/nuvemshop/price-sync";
import { runStockSync, stockActivationBlockers } from "@/lib/nuvemshop/stock-sync";
import { clientForConnectedStore } from "@/lib/nuvemshop/store";
import { processWriteJobs, resolveJobManually, resolveUncertainJobs } from "@/lib/nuvemshop/write-jobs";
import { getSql } from "@/lib/sql";
import { actorOf, connectedStoreId } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/nuvemshop/automation — painel de automações (modos, execuções, fila, bloqueios, pedidos, webhooks). */
export const GET = adminHandler(async () => jsonNoStore(await automationOverview(getSql())));

const Kind = z.enum(["PRICE", "STOCK"]);
const Id = z.string().regex(/^\d{1,20}$/);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_mode"), kind: Kind, mode: z.enum(["DISABLED", "SHADOW", "PILOT", "AUTOMATIC"]), confirmation: z.string().max(60).nullish(), reason: z.string().max(300).nullish() }),
  z.object({ action: z.literal("pause"), kind: Kind, reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("resume"), kind: Kind }),
  z.object({ action: z.literal("simulate"), kind: Kind, variantIds: z.array(Id).max(300).optional() }),
  z.object({ action: z.literal("settings"), kind: Kind, patch: settingsPatchSchema }),
  z.object({ action: z.literal("participation"), kind: Kind, variantIds: z.array(Id).min(1).max(500), participation: z.enum(["NONE", "PILOT", "INCLUDED", "EXCLUDED"]) }),
  z.object({ action: z.literal("approve_price"), itemId: Id }),
  z.object({ action: z.literal("resolve_job"), jobId: z.string().uuid(), note: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("reconcile"), target: z.enum(["orders", "catalog", "uncertain", "writer"]) }),
  z.object({ action: z.literal("register_webhooks") }),
  z.object({ action: z.literal("confirm_ads"), orderId: Id, reference: z.string().trim().max(80).nullish() }),
  z.object({ action: z.literal("emergency_stop"), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("release_emergency"), confirmation: z.literal("LIBERAR") }),
]);

const blockersOf = (kind: AutomationKind) => (kind === "PRICE" ? priceActivationBlockers : stockActivationBlockers);

/**
 * POST /api/nuvemshop/automation — ações administrativas das automações Nuvemshop. Todas registram auditoria.
 * Escritas reais só acontecem pela fila (PILOT/AUTOMATIC) ou por aprovação explícita de item em revisão.
 */
export const POST = adminHandler(
  async (req) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonNoStore({ error: "invalid_body", message: "Requisição inválida", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 422);
    const sql = getSql();
    const actor = actorOf(req);
    const b = parsed.data;
    const deadline = Date.now() + 45_000;
    switch (b.action) {
      case "set_mode":
        return jsonNoStore(await setAutomationMode(sql, b.kind, { mode: b.mode, confirmation: b.confirmation ?? null, reason: b.reason ?? null }, actor, () => blockersOf(b.kind)(sql)));
      case "pause":
        return jsonNoStore(await pauseAutomation(sql, b.kind, actor, b.reason));
      case "resume":
        return jsonNoStore(await resumeAutomation(sql, b.kind, actor, () => blockersOf(b.kind)(sql)));
      case "simulate":
        return jsonNoStore(
          b.kind === "PRICE"
            ? await runPriceSync(sql, { trigger: "simulation", requestedBy: actor, simulate: true, variantIds: b.variantIds, deadline })
            : await runStockSync(sql, { trigger: "simulation", requestedBy: actor, simulate: true, variantIds: b.variantIds, deadline }),
        );
      case "settings":
        return jsonNoStore(await updateAutomationSettings(sql, b.kind, b.patch, actor));
      case "participation":
        return jsonNoStore({ updated: await setParticipation(sql, { storeId: await connectedStoreId(sql), kind: b.kind, variantIds: b.variantIds, participation: b.participation, actor }) });
      case "approve_price":
        return jsonNoStore(await approvePriceReview(sql, b.itemId, actor));
      case "resolve_job":
        await resolveJobManually(sql, b.jobId, actor, b.note);
        return jsonNoStore({ ok: true });
      case "reconcile": {
        if (b.target === "catalog") return jsonNoStore({ job: await createImportJob(sql, { mode: "INCREMENTAL", actor }) });
        if (b.target === "uncertain") return jsonNoStore(await resolveUncertainJobs(sql));
        if (b.target === "writer") return jsonNoStore(await processWriteJobs(sql, { deadline }));
        const conn = await clientForConnectedStore(sql);
        return jsonNoStore(await reconcileOrders(sql, conn.client, conn.store.storeId, { deadline }));
      }
      case "register_webhooks":
        return jsonNoStore(await registerWebhooks(sql, actor));
      case "confirm_ads":
        return jsonNoStore(await confirmAdsReflection(sql, { storeId: await connectedStoreId(sql), orderId: b.orderId, actor, reference: b.reference ?? null }));
      case "emergency_stop":
        return jsonNoStore(await activateEmergencyStop(sql, actor, b.reason));
      case "release_emergency":
        await releaseEmergencyStop(sql, actor);
        return jsonNoStore({ ok: true });
      default:
        return errorJson(422, "invalid_action", "Ação inválida");
    }
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
