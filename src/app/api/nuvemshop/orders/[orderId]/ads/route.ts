import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { adsEnvironment, assertAdsWriteAllowed } from "@/lib/ads/client";
import { getAdsOrderSettings } from "@/lib/ads/commercial";
import { buildCustomerDraft, createAdsCustomerFromBilling } from "@/lib/ads/customers";
import { municipiosByUf } from "@/lib/ads/ibge";
import { sanitizePayload } from "@/lib/ads/order-payload";
import { errorJson, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { maskDocument } from "@/lib/marketplace/billing";
import {
  buildNsAdsOrder,
  chooseNsBillingCity,
  getNsBilling,
  getNsOrderRow,
  listNsAttempts,
  listNsSubmissions,
  lookupNsCustomer,
  nsCustomerContext,
  reconcileNsSubmission,
  refreshNsAdsStatus,
  refreshNsOrderForAds,
  sendNsOrderToAds,
} from "@/lib/nuvemshop/ads-orders";
import { clientForConnectedStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";
import { actorOf, catalogStoreId } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function orderIdOf(ctx: RouteContext<{ orderId: string }>): Promise<string | null> {
  const { orderId } = await ctx.params;
  return /^\d{1,20}$/.test(orderId) ? orderId : null;
}

/**
 * Estado do envio do pedido Nuvemshop à ADS: comprador, cliente ADS, validação, prévia do payload (documento
 * mascarado), envios e chamadas. ?reveal=1 mostra o CPF/CNPJ completo (acesso registrado).
 */
export const GET = adminHandler(
  async (req, ctx: RouteContext<{ orderId: string }>) => {
    const orderId = await orderIdOf(ctx);
    if (!orderId) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    const storeId = await catalogStoreId(sql);
    const order = await getNsOrderRow(sql, storeId, orderId);
    if (!order) return errorJson(404, "not_found", "Pedido Nuvemshop não encontrado");
    const reveal = req.nextUrl.searchParams.get("reveal") === "1";
    if (reveal) logger.info("Visualização do documento do comprador (Nuvemshop)", { orderId });
    const settings = await getAdsOrderSettings(sql, "nuvemshop");
    const built = await buildNsAdsOrder(sql, storeId, orderId, { settings });
    const billing = built.billing;
    const draft =
      billing && built.customer && built.customer.status !== "FOUND" && built.customer.status !== "CREATED"
        ? await buildCustomerDraft(billing, settings, { ...nsCustomerContext(sql, storeId, orderId) }).catch(() => null)
        : null;
    const cityOptions = draft && !draft.city && billing?.address.state ? municipiosByUf(billing.address.state).map((m) => ({ code: m.code, name: m.name })) : null;
    return jsonNoStore({
      environment: adsEnvironment(),
      settingsConfigured: !!settings,
      externalId: built.externalId,
      order: {
        orderId,
        number: order.number,
        status: order.status,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        adsConfirmedAt: order.adsConfirmedAt,
        adsReference: order.adsReference,
      },
      lines: built.lines,
      validation: { ok: built.ok, issues: built.issues, totals: built.totals },
      payload: sanitizePayload(built.payload),
      payloadHash: built.ok ? built.payloadHash : null,
      billing: billing ? { ...billing, docNumber: reveal ? billing.docNumber : maskDocument(billing.docNumber) } : null,
      customer: built.customer ? { ...built.customer, cnpjCpf: maskDocument(built.customer.cnpjCpf), draft: undefined } : null,
      customerDraft: draft ? { missing: draft.missing, city: draft.city, cityOptions, request: { ...draft.request, cnpjCpf: maskDocument(String(draft.request.cnpjCpf ?? "")) } } : null,
      submissions: await listNsSubmissions(sql, storeId, orderId),
      attempts: await listNsAttempts(sql, storeId, orderId),
    });
  },
  { rateLimitPerMinute: 60 },
);

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("customer_lookup") }),
  z.object({ action: z.literal("customer_create"), confirm: z.literal("CADASTRAR") }),
  z.object({ action: z.literal("send"), confirm: z.enum(["ENVIAR", "ENVIAR PRODUCAO"]), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal("set_city"), ibge: z.string().regex(/^\d{7}$/) }),
  z.object({ action: z.literal("reconcile") }),
  z.object({ action: z.literal("status") }),
]);

/** Ações do operador. Escritas na ADS (cliente, pedido) só com escrita liberada no ambiente e confirmação explícita. */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ orderId: string }>) => {
    const orderId = await orderIdOf(ctx);
    if (!orderId) return errorJson(400, "invalid_id", "ID inválido");
    const b = await parseJsonBody(req, action);
    if (!b.ok) return b.response;
    const sql = getSql();
    const by = actorOf(req);
    const storeId = await catalogStoreId(sql);
    if (!(await getNsOrderRow(sql, storeId, orderId))) return errorJson(404, "not_found", "Pedido Nuvemshop não encontrado");
    switch (b.data.action) {
      case "refresh": {
        // Somente leitura na Nuvemshop: valores, linhas e dados do comprador; já identifica o cliente na ADS.
        const conn = await clientForConnectedStore(sql);
        const { billing } = await refreshNsOrderForAds(sql, conn.client, storeId, orderId);
        const customer = billing.docNumber && billing.docNumber.length >= 11 ? await lookupNsCustomer(sql, storeId, orderId).catch(() => null) : null;
        return jsonNoStore({ billing: { ...billing, docNumber: maskDocument(billing.docNumber) }, customerStatus: customer?.status ?? null });
      }
      case "customer_lookup": {
        const c = await lookupNsCustomer(sql, storeId, orderId);
        return jsonNoStore({ customer: { ...c, cnpjCpf: maskDocument(c.cnpjCpf), draft: undefined } });
      }
      case "customer_create": {
        const billing = await getNsBilling(sql, storeId, orderId);
        const c = await createAdsCustomerFromBilling(sql, billing, await getAdsOrderSettings(sql, "nuvemshop"), by, nsCustomerContext(sql, storeId, orderId));
        return jsonNoStore({ customer: { ...c, cnpjCpf: maskDocument(c.cnpjCpf), draft: undefined } });
      }
      case "send": {
        assertAdsWriteAllowed();
        const expected = adsEnvironment().environment === "producao" ? "ENVIAR PRODUCAO" : "ENVIAR";
        if (b.data.confirm !== expected) return errorJson(400, "confirmation_required", `Confirme digitando ${expected}`);
        const s = await sendNsOrderToAds(sql, storeId, orderId, { payloadHash: b.data.payloadHash, requestedBy: by });
        return jsonNoStore({ submission: s });
      }
      case "set_city": {
        const city = await chooseNsBillingCity(sql, storeId, orderId, b.data.ibge);
        logger.info("Município do endereço escolhido pelo operador (Nuvemshop)", { orderId, ibge: city.code });
        return jsonNoStore({ city });
      }
      case "reconcile":
        return jsonNoStore({ submission: await reconcileNsSubmission(sql, storeId, orderId) });
      case "status":
        return jsonNoStore({ submission: await refreshNsAdsStatus(sql, storeId, orderId) });
    }
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
