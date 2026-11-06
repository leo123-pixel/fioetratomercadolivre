import { z } from "zod";
import { adminHandler, type RouteContext } from "@/lib/api";
import { adsEnvironment, assertAdsWriteAllowed } from "@/lib/ads/client";
import { getAdsOrderSettings } from "@/lib/ads/commercial";
import { buildCustomerDraft, createAdsCustomer, lookupAdsCustomer, setCustomerCity } from "@/lib/ads/customers";
import { municipiosByUf } from "@/lib/ads/ibge";
import { buildAdsOrder, sanitizePayload } from "@/lib/ads/order-payload";
import { listAttempts, listSubmissions, reconcileSubmission, refreshAdsStatus, sendOrderToAds } from "@/lib/ads/order-submission";
import { getAdminSession } from "@/lib/auth/admin";
import { errorJson, jsonNoStore } from "@/lib/http";
import { logger } from "@/lib/logger";
import { fetchOrderBilling, getOrderBilling, maskDocument } from "@/lib/marketplace/billing";
import { requesterFromSession } from "@/lib/publish/service";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function orderId(ctx: RouteContext<{ id: string }>): Promise<string | null> {
  const { id } = await ctx.params;
  return /^\d{1,18}$/.test(id) ? id : null;
}

/**
 * Estado da integração ADS do pedido: comprador, cliente ADS, validação, prévia do payload
 * (documento mascarado), envios e histórico. ?reveal=1 mostra o CPF/CNPJ completo (acesso registrado).
 */
export const GET = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const id = await orderId(ctx);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const sql = getSql();
    const [exists] = await sql.query(`SELECT 1 FROM marketplace_order_inbox WHERE id = $1::bigint`, [id]);
    if (!exists) return errorJson(404, "not_found", "Pedido não encontrado");
    const reveal = req.nextUrl.searchParams.get("reveal") === "1";
    if (reveal) logger.info("Visualização do documento do comprador", { orderInboxId: id });
    const settings = await getAdsOrderSettings(sql);
    const built = await buildAdsOrder(sql, id, { settings });
    const billing = built.billing;
    const draft = billing && built.customer && built.customer.status !== "FOUND" && built.customer.status !== "CREATED" ? await buildCustomerDraft(billing, settings, { sql, orderInboxId: id }).catch(() => null) : null;
    // Município não resolvido: lista oficial da UF para o operador escolher.
    const cityOptions = draft && !draft.city && billing?.address.state ? municipiosByUf(billing.address.state).map((m) => ({ code: m.code, name: m.name })) : null;
    return jsonNoStore({
      environment: adsEnvironment(),
      externalId: built.externalId,
      validation: { ok: built.ok, issues: built.issues, totals: built.totals },
      payload: sanitizePayload(built.payload),
      payloadHash: built.ok ? built.payloadHash : null,
      billing: billing ? { ...billing, docNumber: reveal ? billing.docNumber : maskDocument(billing.docNumber) } : null,
      customer: built.customer ? { ...built.customer, cnpjCpf: maskDocument(built.customer.cnpjCpf), draft: undefined } : null,
      customerDraft: draft ? { missing: draft.missing, city: draft.city, cityOptions, request: { ...draft.request, cnpjCpf: maskDocument(String(draft.request.cnpjCpf ?? "")) } } : null,
      submissions: (await listSubmissions(sql, id)).map((s) => ({ ...s, payload: undefined })),
      attempts: await listAttempts(sql, id),
    });
  },
  { rateLimitPerMinute: 60 },
);

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("billing") }),
  z.object({ action: z.literal("customer_lookup") }),
  z.object({ action: z.literal("customer_create"), confirm: z.literal("CADASTRAR") }),
  z.object({ action: z.literal("send"), confirm: z.enum(["ENVIAR", "ENVIAR PRODUCAO"]), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal("set_city"), ibge: z.string().regex(/^d{7}$/) }),
  z.object({ action: z.literal("reconcile") }),
  z.object({ action: z.literal("status") }),
]);

/** Ações do operador. Escritas na ADS (cliente, pedido) só em homologação e com confirmação explícita. */
export const POST = adminHandler(
  async (req, ctx: RouteContext<{ id: string }>) => {
    const id = await orderId(ctx);
    if (!id) return errorJson(400, "invalid_id", "ID inválido");
    const b = await parseJsonBody(req, action);
    if (!b.ok) return b.response;
    const sql = getSql();
    const by = requesterFromSession(getAdminSession(req)?.sid);
    switch (b.data.action) {
      case "billing": {
        const billing = await fetchOrderBilling(sql, id);
        // Já identifica o cliente na ADS quando há documento (somente leitura).
        const customer = billing.docNumber && billing.docNumber.length >= 11 ? await lookupAdsCustomer(sql, billing.docNumber, id) : null;
        return jsonNoStore({ billing: { ...billing, docNumber: maskDocument(billing.docNumber) }, customerStatus: customer?.status ?? null });
      }
      case "customer_lookup": {
        const billing = await getOrderBilling(sql, id);
        if (!billing?.docNumber) return errorJson(409, "no_billing", "Consulte os dados fiscais do comprador antes");
        const c = await lookupAdsCustomer(sql, billing.docNumber, id);
        return jsonNoStore({ customer: { ...c, cnpjCpf: maskDocument(c.cnpjCpf), draft: undefined } });
      }
      case "customer_create": {
        const c = await createAdsCustomer(sql, id, await getAdsOrderSettings(sql), by);
        return jsonNoStore({ customer: { ...c, cnpjCpf: maskDocument(c.cnpjCpf), draft: undefined } });
      }
      case "send": {
        // Primeiro a trava do ambiente; depois a confirmação (reforçada em produção: estoque, financeiro e NF-e reais).
        assertAdsWriteAllowed();
        const expected = adsEnvironment().environment === "producao" ? "ENVIAR PRODUCAO" : "ENVIAR";
        if (b.data.confirm !== expected) return errorJson(400, "confirmation_required", `Confirme digitando ${expected}`);
        const s = await sendOrderToAds(sql, id, { payloadHash: b.data.payloadHash, requestedBy: by });
        return jsonNoStore({ submission: { ...s, payload: undefined } });
      }
      case "set_city": {
        // Só grava no integrador (endereço do pedido); nada é enviado à ADS aqui.
        const city = await setCustomerCity(sql, id, b.data.ibge);
        logger.info("Município do endereço escolhido pelo operador", { orderInboxId: id, ibge: city.code });
        return jsonNoStore({ city });
      }
      case "reconcile": {
        const s = await reconcileSubmission(sql, id);
        return jsonNoStore({ submission: { ...s, payload: undefined } });
      }
      case "status": {
        const s = await refreshAdsStatus(sql, id);
        return jsonNoStore({ submission: { ...s, payload: undefined } });
      }
    }
  },
  { mutating: true, rateLimitPerMinute: 20 },
);
