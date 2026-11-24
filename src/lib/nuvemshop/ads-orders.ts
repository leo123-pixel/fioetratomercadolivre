import "server-only";
import { randomUUID } from "node:crypto";
import { adsCall, AdsApiError, adsEnvironment, adsProblem, assertAdsWriteAllowed } from "../ads/client";
import { getAdsOrderSettings, prazoDays, type AdsOrderSettings } from "../ads/commercial";
import { getAdsCustomer, lookupAdsCustomer, type AdsCustomer, type AttemptRecord, type CustomerContext, type ResolvedCity } from "../ads/customers";
import { municipioByCode } from "../ads/ibge";
import { buildInstallments, canonicalHash, sanitizePayload, type AdsOrderItem, type AdsOrderPayload, type Issue } from "../ads/order-payload";
import { lookupByExternalId, SubmissionError } from "../ads/order-submission";
import { recordOrderEvents } from "../inventory/ingest";
import type { ReservationEvent } from "../inventory/reservations";
import { getInventorySettings } from "../inventory/settings";
import { logger, redactString } from "../logger";
import { maskDocument, missingBillingFields, validDocument, type BillingData, type StoredBilling } from "../marketplace/billing";
import type { Sql } from "../sql";
import { NuvemshopApiError, type NuvemshopApiClient } from "./client";
import { commitmentFromStates, money, upsertOrder, type NsOrder, type OrderLine } from "./orders";

/**
 * Pedidos Nuvemshop → ADS (envio MANUAL, mesmas travas do Mercado Livre — ver ads/order-submission.ts):
 * - um pedido ADS por pedido Nuvemshop, idExterno "N" + id do pedido; pedidoCliente = número da loja (#);
 * - configuração comercial própria do canal (Configurações › Pedidos ADS › Nuvemshop; tabela padrão F);
 * - dados fiscais do comprador lidos SOB DEMANDA (GET /orders/{id} com os campos contact_/billing_), guardados em
 *   nuvemshop_order_billing; o cliente ADS (ads_customers) é o mesmo do ML para o mesmo CPF/CNPJ;
 * - itens pelo vínculo CONFIRMADO variante → produto ADS; kit (composição) bloqueia (lançar no ADSNET);
 * - totais conferidos com a Nuvemshop: soma dos itens = subtotal; com frete pago pelo comprador e desconto do
 *   pedido, total ADS = total pago;
 * - produção só com ADS_PRODUCTION_WRITE_ENABLED=true; payload aprovado conferido por hash; consulta o idExterno
 *   antes do POST (sem duplicar); timeout/5xx = UNKNOWN, resolvido pela conciliação (nunca reenvia sozinho);
 * - cada mudança do envio vira fato ADS_ORDER_* nos compromissos do Inventory Core (a política decide se a baixa
 *   já está refletida — sem baixa dupla).
 * Nunca é chamado por webhook ou rotina automática.
 */
export const externalIdForNsOrder = (orderId: string) => `N${orderId}`;


// ---------------------------------------------------------------------------------------------------------------
// Dados fiscais do comprador
// ---------------------------------------------------------------------------------------------------------------

const UF_BY_NAME: Record<string, string> = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA", ceara: "CE", "distrito federal": "DF", "espirito santo": "ES",
  goias: "GO", maranhao: "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG", para: "PA", paraiba: "PB", parana: "PR",
  pernambuco: "PE", piaui: "PI", "rio de janeiro": "RJ", "rio grande do norte": "RN", "rio grande do sul": "RS", rondonia: "RO", roraima: "RR",
  "santa catarina": "SC", "sao paulo": "SP", sergipe: "SE", tocantins: "TO",
};
const UFS = new Set(Object.values(UF_BY_NAME));
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** "São Paulo", "SP", "BR-SP" → "SP". Desconhecido → o texto original (o validador acusa a UF inválida). */
export function ufOf(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return null;
  const code = t.toUpperCase().replace(/^BR-/, "");
  if (UFS.has(code)) return code;
  return UF_BY_NAME[norm(t)] ?? t.slice(0, 30);
}

const str = (v: unknown, max = 200): string | null => {
  if (v === null || v === undefined || typeof v === "object") return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};
const digits = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/\D/g, ""));
const phoneOf = (v: unknown): string | null => {
  const d = digits(v);
  const local = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
  return local.length === 10 || local.length === 11 ? local : null;
};
const emailOf = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(t) ? t.toLowerCase() : null;
};

/**
 * Dados fiscais a partir do pedido Nuvemshop. Endereço de cobrança (billing_*); sem rua de cobrança, usa o
 * endereço de entrega. Nada é inventado: campo ausente fica em "missing".
 */
export function parseNsBilling(o: Record<string, unknown>): BillingData {
  const ship = (o.shipping_address && typeof o.shipping_address === "object" ? o.shipping_address : {}) as Record<string, unknown>;
  const useShipping = !str(o.billing_address) && !!str(ship.address);
  const a = useShipping
    ? { street: ship.address, number: ship.number, complement: ship.floor, neighborhood: ship.locality, city: ship.city, state: ship.province, zip: ship.zipcode }
    : { street: o.billing_address, number: o.billing_number, complement: o.billing_floor, neighborhood: o.billing_locality, city: o.billing_city, state: o.billing_province, zip: o.billing_zipcode };
  const doc = digits(o.contact_identification);
  const rawType = str(o.billing_document_type)?.toUpperCase() ?? null;
  const docType = doc.length === 11 ? "CPF" : doc.length === 14 ? "CNPJ" : rawType === "CPF" || rawType === "CNPJ" ? rawType : null;
  const business = str(o.billing_business_name, 150);
  const person = str(o.billing_name, 150) ?? str(o.contact_name, 150) ?? (useShipping ? str(ship.name, 150) : null);
  return {
    billingInfoId: null,
    docType,
    docNumber: doc || null,
    name: docType === "CNPJ" ? (business ?? person) : (person ?? business),
    stateRegistration: str(o.billing_state_registration, 30),
    taxpayerType: str(o.billing_customer_type, 60),
    address: {
      street: str(a.street, 100),
      number: str(a.number, 10),
      complement: str(a.complement, 60),
      neighborhood: str(a.neighborhood, 60),
      city: str(a.city, 80),
      state: ufOf(a.state),
      zip: digits(a.zip) || null,
      phone: phoneOf(o.billing_phone) ?? phoneOf(o.contact_phone) ?? phoneOf(ship.phone),
      email: emailOf(o.contact_email),
    },
  };
}

export async function getNsBilling(sql: Sql, storeId: string, orderId: string): Promise<StoredBilling | null> {
  const [b] = await sql.query<StoredBilling & { cityIbgeCode: string | null; cityIbgeName: string | null; cityIbgeSource: string | null }>(
    `SELECT NULL AS "billingInfoId", status, doc_type AS "docType", doc_number AS "docNumber", name, state_registration AS "stateRegistration",
            taxpayer_type AS "taxpayerType", address, missing, fetched_at AS "fetchedAt",
            city_ibge AS "cityIbgeCode", city_ibge_name AS "cityIbgeName", city_ibge_source AS "cityIbgeSource"
     FROM nuvemshop_order_billing WHERE store_id = $1 AND order_id = $2::bigint`,
    [storeId, orderId],
  );
  if (!b) return null;
  const { cityIbgeCode, cityIbgeName, cityIbgeSource, ...rest } = b;
  return { ...rest, cityIbge: cityIbgeCode ? { code: cityIbgeCode, name: cityIbgeName ?? "", source: cityIbgeSource as ResolvedCity["source"] } : null };
}

async function saveNsBilling(sql: Sql, storeId: string, orderId: string, data: BillingData): Promise<StoredBilling> {
  const missing = missingBillingFields(data);
  const status: StoredBilling["status"] = !data.docNumber && !data.address.street ? "UNAVAILABLE" : missing.length ? "INCOMPLETE" : "COMPLETE";
  // Município escolhido manualmente é mantido enquanto CEP e UF não mudarem; o resto é recalculado.
  await sql.execute(
    `INSERT INTO nuvemshop_order_billing (store_id, order_id, status, doc_type, doc_number, name, state_registration, taxpayer_type, address, missing, fetched_at, updated_at)
     VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now(), now())
     ON CONFLICT (store_id, order_id) DO UPDATE SET status = EXCLUDED.status, doc_type = EXCLUDED.doc_type, doc_number = EXCLUDED.doc_number, name = EXCLUDED.name,
       state_registration = EXCLUDED.state_registration, taxpayer_type = EXCLUDED.taxpayer_type, missing = EXCLUDED.missing, fetched_at = now(), updated_at = now(),
       city_ibge = CASE WHEN nuvemshop_order_billing.city_ibge_source = 'MANUAL' AND nuvemshop_order_billing.address->>'zip' IS NOT DISTINCT FROM EXCLUDED.address->>'zip'
                         AND nuvemshop_order_billing.address->>'state' IS NOT DISTINCT FROM EXCLUDED.address->>'state' THEN nuvemshop_order_billing.city_ibge END,
       city_ibge_name = CASE WHEN nuvemshop_order_billing.city_ibge_source = 'MANUAL' AND nuvemshop_order_billing.address->>'zip' IS NOT DISTINCT FROM EXCLUDED.address->>'zip'
                         AND nuvemshop_order_billing.address->>'state' IS NOT DISTINCT FROM EXCLUDED.address->>'state' THEN nuvemshop_order_billing.city_ibge_name END,
       city_ibge_source = CASE WHEN nuvemshop_order_billing.city_ibge_source = 'MANUAL' AND nuvemshop_order_billing.address->>'zip' IS NOT DISTINCT FROM EXCLUDED.address->>'zip'
                         AND nuvemshop_order_billing.address->>'state' IS NOT DISTINCT FROM EXCLUDED.address->>'state' THEN 'MANUAL' END,
       address = EXCLUDED.address`,
    [storeId, orderId, status, data.docType, data.docNumber, data.name, data.stateRegistration, data.taxpayerType, JSON.stringify(data.address), JSON.stringify(missing)],
  );
  return (await getNsBilling(sql, storeId, orderId))!;
}

export async function setNsBillingCity(sql: Sql, storeId: string, orderId: string, city: ResolvedCity): Promise<void> {
  await sql.execute(
    `UPDATE nuvemshop_order_billing SET city_ibge = $3, city_ibge_name = $4, city_ibge_source = $5, updated_at = now() WHERE store_id = $1 AND order_id = $2::bigint`,
    [storeId, orderId, city.code, city.name, city.source],
  );
}

/** Operador escolhe o município (lista oficial do IBGE, na UF do endereço). */
export async function chooseNsBillingCity(sql: Sql, storeId: string, orderId: string, code: string): Promise<ResolvedCity> {
  const billing = await getNsBilling(sql, storeId, orderId);
  if (!billing) throw new SubmissionError("no_billing", "Consulte os dados do comprador antes");
  const m = municipioByCode(code);
  if (!m) throw new SubmissionError("invalid_city", "Código IBGE inexistente na lista oficial");
  if (billing.address.state && m.uf !== billing.address.state) throw new SubmissionError("invalid_city", `O município escolhido é de ${m.uf}, mas o endereço é de ${billing.address.state}`);
  const city: ResolvedCity = { code: m.code, name: m.name, source: "MANUAL" };
  await setNsBillingCity(sql, storeId, orderId, city);
  return city;
}

/**
 * Relê o pedido na Nuvemshop (valores, linhas e dados do comprador) e grava. Somente leitura na Nuvemshop.
 * O pedido também é reprocessado na proteção de estoque (idempotente).
 */
export async function refreshNsOrderForAds(sql: Sql, client: NuvemshopApiClient, storeId: string, orderId: string): Promise<{ order: NsOrder; billing: StoredBilling }> {
  let data: NsOrder & Record<string, unknown>;
  // Leitura completa (sem `fields`: a Nuvemshop recusa alguns campos no filtro). O frete do comprador fica nos
  // fulfillment orders (aggregates); se o agregado falhar, lê o pedido sem ele. Só parseNsBilling é gravado.
  const read = (query?: Record<string, string>) => client.get<NsOrder & Record<string, unknown>>(`/orders/${orderId}`, query).then((r) => r.data);
  try {
    data = await read({ aggregates: "fulfillment_orders" }).catch((err) => {
      if (err instanceof NuvemshopApiError && err.kind === "not_found") throw err;
      logger.warn("Nuvemshop: pedido com fulfillment_orders falhou; lendo sem o agregado", { orderId, err: (err as Error).message });
      return read();
    });
  } catch (err) {
    if (err instanceof NuvemshopApiError && err.kind === "not_found") throw new SubmissionError("order_not_found", "Pedido não encontrado na Nuvemshop");
    throw err;
  }
  const shipping = nsShippingCost(data);
  if (shipping.source !== "order_field") logger.info("Nuvemshop: frete do comprador", { orderId, source: shipping.source, value: shipping.value });
  data = { ...data, shipping_cost_customer: shipping.value };
  await upsertOrder(sql, storeId, data, "MANUAL");
  const billing = await saveNsBilling(sql, storeId, orderId, parseNsBilling(data));
  return { order: data, billing };
}

/** Valor Money da API: número, texto ou objeto {value|amount}. */
function moneyValue(v: unknown): number | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return money(o.value ?? o.amount ?? null);
  }
  return money(v);
}

/** Procura `consumer_cost` dentro de um fulfillment order (o caminho exato varia: shipping.option, shipping...). */
function findConsumerCost(v: unknown, depth = 0): number | null {
  if (!v || typeof v !== "object" || depth > 4) return null;
  const o = v as Record<string, unknown>;
  if ("consumer_cost" in o) return moneyValue(o.consumer_cost);
  for (const child of Object.values(o)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const found = findConsumerCost(child, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Desconto total do pedido: `discount` é o total; em pedidos antigos só vêm cupom + meio de pagamento. */
export function nsDiscountTotal(o: { discount?: unknown; discount_coupon?: unknown; discount_gateway?: unknown }): number {
  return Math.max(money(o.discount) ?? 0, round2((money(o.discount_coupon) ?? 0) + (money(o.discount_gateway) ?? 0)));
}

/**
 * Frete pago pelo comprador. Na API 2025-03 o pedido não traz mais esse valor: ele fica em cada fulfillment order
 * (`consumer_cost`, com aggregates=fulfillment_orders). Sem isso, usa o campo antigo shipping_cost_customer e, por
 * último, a identidade documentada total = subtotal − desconto + frete.
 */
export function nsShippingCost(o: Record<string, unknown>): { value: number | null; source: "fulfillment" | "order_field" | "derived" | null } {
  const fulfillments = Array.isArray(o.fulfillments) ? o.fulfillments : [];
  const costs = fulfillments.map((f) => findConsumerCost(f)).filter((c): c is number => c !== null);
  if (costs.length) return { value: round2(costs.reduce((a, c) => a + c, 0)), source: "fulfillment" };
  const field = money(o.shipping_cost_customer);
  if (field !== null) return { value: field, source: "order_field" };
  const total = money(o.total);
  const subtotal = money(o.subtotal);
  if (total === null || subtotal === null) return { value: null, source: null };
  const derived = round2(total - subtotal + nsDiscountTotal(o));
  return derived >= 0 ? { value: derived, source: "derived" } : { value: null, source: null };
}

/** Contexto do cadastro de cliente ADS para um pedido Nuvemshop (histórico e município nas tabelas do canal). */
export function nsCustomerContext(sql: Sql, storeId: string, orderId: string): CustomerContext {
  return {
    log: (a) => logNsAttempt(sql, storeId, orderId, null, a),
    saveCity: (city) => setNsBillingCity(sql, storeId, orderId, city),
    channelLabel: "Nuvemshop",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Validação e payload
// ---------------------------------------------------------------------------------------------------------------

interface OrderRow {
  orderId: string;
  number: string | null;
  status: string | null;
  paymentStatus: string | null;
  cancelledAt: Date | null;
  createdAt: Date | null;
  paidAt: Date | null;
  lines: OrderLine[];
  subtotal: string | null;
  discount: string | null;
  discountCoupon: string | null;
  discountGateway: string | null;
  shippingCustomer: string | null;
  total: string | null;
  adsConfirmedAt: Date | null;
  adsReference: string | null;
}

export interface NsBuildResult {
  storeId: string;
  orderId: string;
  number: string | null;
  externalId: string;
  payload: AdsOrderPayload | null;
  payloadHash: string | null;
  issues: Issue[];
  ok: boolean;
  billing: StoredBilling | null;
  customer: AdsCustomer | null;
  lines: { lineId: string; variantId: string | null; sku: string | null; name: string | null; quantity: number; price: number | null; adsProductId: number | null; problem: string | null }[];
  totals: { itemsAds: number; itemsNs: number; nsSubtotal: number | null; nsDiscount: number | null; nsShipping: number | null; nsTotal: number | null; adsTotal: number | null };
}

const cents = (n: number) => Math.round(n * 100);
const round2 = (n: number) => cents(n) / 100;
const num = (v: string | null) => (v === null || v === undefined ? null : Number(v));
const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(2));

export async function getNsOrderRow(sql: Sql, storeId: string, orderId: string): Promise<OrderRow | null> {
  const [o] = await sql.query<OrderRow>(
    `SELECT order_id::text AS "orderId", number::text AS number, status, payment_status AS "paymentStatus", cancelled_at AS "cancelledAt",
            remote_created_at AS "createdAt", paid_at AS "paidAt", lines, subtotal::text AS subtotal, discount::text AS discount,
            discount_coupon::text AS "discountCoupon", discount_gateway::text AS "discountGateway", shipping_cost_customer::text AS "shippingCustomer",
            total::text AS total, ads_confirmed_at AS "adsConfirmedAt", ads_reference AS "adsReference"
     FROM nuvemshop_orders WHERE store_id = $1 AND order_id = $2::bigint`,
    [storeId, orderId],
  );
  return o ?? null;
}

/** Monta e valida o pedido ADS. Qualquer inconsistência é um problema "bloqueante" (nada é enviado). */
export async function buildNsAdsOrder(sql: Sql, storeId: string, orderId: string, opts: { settings?: AdsOrderSettings | null } = {}): Promise<NsBuildResult> {
  const issues: Issue[] = [];
  const block = (code: string, message: string) => issues.push({ code, message, blocking: true });
  const warn = (code: string, message: string) => issues.push({ code, message, blocking: false });
  const o = await getNsOrderRow(sql, storeId, orderId);
  if (!o) throw new SubmissionError("order_not_found", "Pedido Nuvemshop não encontrado");
  const externalId = externalIdForNsOrder(orderId);
  const settings = opts.settings === undefined ? await getAdsOrderSettings(sql, "nuvemshop") : opts.settings;
  const billing = await getNsBilling(sql, storeId, orderId);
  const customer = billing?.docNumber ? await getAdsCustomer(sql, billing.docNumber) : null;
  const totals: NsBuildResult["totals"] = { itemsAds: 0, itemsNs: 0, nsSubtotal: num(o.subtotal), nsDiscount: null, nsShipping: num(o.shippingCustomer), nsTotal: num(o.total), adsTotal: null };

  // Situação e pagamento.
  if (o.status === "cancelled" || o.cancelledAt) block("order_cancelled", "Pedido cancelado na Nuvemshop");
  if (o.paymentStatus !== "paid") block("payment_not_paid", `Pagamento não confirmado na Nuvemshop (situação: ${o.paymentStatus ?? "desconhecida"})`);
  if (o.adsConfirmedAt) block("ads_confirmed_manually", `Baixa na ADS já confirmada manualmente${o.adsReference ? ` (referência ${o.adsReference})` : ""}: o pedido provavelmente já foi lançado no ADSNET`);
  if (totals.nsTotal === null || totals.nsSubtotal === null) block("values_missing", "Valores do pedido ainda não lidos: clique em \"Reler pedido na Nuvemshop\"");
  else if (totals.nsShipping === null) block("values_missing", "Frete do comprador ainda não lido: clique em \"Reler pedido na Nuvemshop\"");

  // Configuração comercial do canal.
  if (!settings) block("settings_missing", "Configuração comercial da ADS para a Nuvemshop não definida (Configurações › Pedidos ADS › Nuvemshop)");

  // Comprador.
  if (!billing) block("billing_missing", "Dados do comprador ainda não lidos: clique em \"Reler pedido na Nuvemshop\"");
  else if (billing.status !== "COMPLETE") {
    const docOk = billing.docNumber && validDocument(billing.docNumber);
    (docOk ? warn : block)("billing_incomplete", `Dados do comprador incompletos: ${billing.missing.join(", ")}`);
  }
  if (billing?.docNumber && !validDocument(billing.docNumber)) block("document_invalid", "CPF/CNPJ do comprador inválido");
  if (billing && !billing.docNumber) block("document_missing", "A Nuvemshop não informou o CPF/CNPJ do comprador");
  if (billing?.docNumber && (!customer || (customer.status !== "FOUND" && customer.status !== "CREATED") || !customer.adsClienteId)) {
    block("customer_not_identified", customer?.status === "AMBIGUOUS" ? "Mais de um cliente com o mesmo documento na ADS" : "Cliente não identificado na ADS (consulte ou cadastre)");
  }
  if (customer?.adsClienteId && customer.lastError === "Cliente inativo na ADS") {
    warn("customer_inactive", `Cliente ${customer.adsClienteId} está INATIVO na ADS: ative no ADSNET (Clientes › Alterar) e clique em "Consultar cliente na ADS de novo" antes de enviar`);
  }

  // Itens: vínculo confirmado variante → produto ADS.
  const lines = (o.lines ?? []).filter((l) => l.quantity > 0);
  if (!lines.length) block("no_items", "Pedido sem itens");
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => !!v))];
  const maps = variantIds.length
    ? await sql.query<{ variantId: string; adsProductId: number | null; components: { productId: number; quantity: number; adsProductId: number | null }[] | null }>(
        `SELECT m.variant_id::text AS "variantId", p.ads_product_id AS "adsProductId",
                (SELECT json_agg(json_build_object('productId', c.product_id, 'quantity', c.quantity, 'adsProductId', cp.ads_product_id))
                 FROM nuvemshop_mapping_components c LEFT JOIN products cp ON cp.id = c.product_id WHERE c.mapping_id = m.id) AS components
         FROM nuvemshop_variant_mappings m LEFT JOIN products p ON p.id = m.product_id
         WHERE m.store_id = $1 AND m.status = 'CONFIRMED' AND m.variant_id = ANY($2::bigint[])`,
        [storeId, variantIds],
      )
    : [];
  const byVariant = new Map(maps.map((m) => [m.variantId, m]));
  const outLines: NsBuildResult["lines"] = [];
  const byProduct = new Map<number, { quantity: number; unitPrice: number }>();
  for (const l of lines) {
    const label = l.sku ?? l.name ?? l.variantId ?? l.lineId;
    const m = l.variantId ? byVariant.get(l.variantId) : undefined;
    let adsProductId: number | null = null;
    let problem: string | null = null;
    const comps = m?.components ?? [];
    if (!m) problem = "sem vínculo ADS confirmado";
    else if (comps.length > 1 || (comps.length === 1 && Number(comps[0].quantity) !== 1)) problem = "kit (composição): lance no ADSNET";
    else adsProductId = comps.length === 1 ? comps[0].adsProductId : m.adsProductId;
    if (!problem && !adsProductId) problem = "produto ADS não encontrado";
    if (l.price === null || l.price === undefined || !(l.price > 0)) problem = problem ?? "preço da linha não informado";
    outLines.push({ lineId: l.lineId, variantId: l.variantId, sku: l.sku, name: l.name ?? null, quantity: l.quantity, price: l.price ?? null, adsProductId, problem });
    totals.itemsNs += l.quantity * Number(l.price ?? 0);
    if (problem) continue;
    const cur = byProduct.get(adsProductId!);
    if (cur && cents(cur.unitPrice) !== cents(l.price!)) block("conflicting_prices", `Produto ADS ${adsProductId} vendido com preços diferentes no mesmo pedido`);
    else if (cur) cur.quantity += l.quantity;
    else byProduct.set(adsProductId!, { quantity: l.quantity, unitPrice: l.price! });
  }
  const unmapped = outLines.filter((l) => l.problem && l.problem !== "preço da linha não informado");
  if (unmapped.length) block("unmapped_items", `${unmapped.length} item(ns) sem produto ADS: ${unmapped.map((l) => `${l.sku ?? l.variantId ?? l.lineId} (${l.problem})`).join(", ")}`);
  const noPrice = outLines.filter((l) => l.problem === "preço da linha não informado");
  if (noPrice.length) block("invalid_price", `Preço unitário não informado em ${noPrice.length} item(ns): releia o pedido na Nuvemshop`);

  // Preço de tabela da ADS (quando configurado para usá-lo).
  const tablePrices = new Map<number, number>();
  if (settings?.itemPriceMode === "ads_table" && byProduct.size) {
    const rows = await sql.query<{ adsProductId: number; price: string }>(
      `SELECT DISTINCT ON (ads_product_id) ads_product_id AS "adsProductId", price::text AS price FROM product_prices
       WHERE ads_product_id = ANY($1::int[]) AND price_table_code = $2::text AND NOT inactive AND price IS NOT NULL
       ORDER BY ads_product_id, branch_id`,
      [[...byProduct.keys()], settings.tabela],
    );
    for (const r of rows) tablePrices.set(r.adsProductId, Number(r.price));
  }
  const itens: AdsOrderItem[] = [];
  for (const [adsProductId, v] of byProduct) {
    let precoTabela = v.unitPrice;
    let percentualDesconto = 0;
    if (settings?.itemPriceMode === "ads_table") {
      const t = tablePrices.get(adsProductId);
      if (t === undefined) block("table_price_missing", `Produto ADS ${adsProductId} sem preço ativo na tabela ${settings.tabela}`);
      else if (t < v.unitPrice) warn("sale_above_table", `Produto ADS ${adsProductId}: vendido acima do preço de tabela; enviado sem desconto`);
      else {
        precoTabela = t;
        percentualDesconto = round2(((t - v.unitPrice) / t) * 100);
      }
    }
    itens.push({
      produtoId: adsProductId,
      categoria: settings?.categoriaItem ?? "",
      codigoTabelaDePreco: settings?.tabela ?? null,
      quantidade: v.quantity,
      precoUnitario: round2(v.unitPrice),
      precoTabela: round2(precoTabela),
      percentualDesconto,
      valorLiquido: round2(v.unitPrice * v.quantity),
      observacao: null,
    });
  }
  totals.itemsAds = round2(itens.reduce((a, i) => a + i.valorLiquido, 0));
  totals.itemsNs = round2(totals.itemsNs);
  if (!unmapped.length && !noPrice.length && cents(totals.itemsAds) !== cents(totals.itemsNs)) block("items_total_mismatch", `Soma dos itens (${fmt(totals.itemsAds)}) difere do vendido na Nuvemshop (${fmt(totals.itemsNs)})`);
  if (totals.nsSubtotal !== null && cents(totals.itemsNs) !== cents(totals.nsSubtotal)) block("subtotal_mismatch", `Itens (${fmt(totals.itemsNs)}) diferem do subtotal do pedido na Nuvemshop (${fmt(totals.nsSubtotal)})`);

  // Desconto do pedido = o que falta para fechar o total pago (subtotal + frete do comprador − total). Assim o total
  // ADS bate com o pago mesmo quando a Nuvemshop soma cupom, promoção e desconto do meio de pagamento.
  const shipping = totals.nsShipping ?? 0;
  const fieldsDiscount = nsDiscountTotal({ discount: o.discount, discount_coupon: o.discountCoupon, discount_gateway: o.discountGateway });
  if (totals.nsSubtotal !== null && totals.nsTotal !== null && totals.nsShipping !== null) {
    const derived = round2(totals.nsSubtotal + shipping - totals.nsTotal);
    totals.nsDiscount = derived;
    if (derived < 0) block("ns_total_inconsistent", `Total da Nuvemshop (${fmt(totals.nsTotal)}) maior que subtotal + frete (${fmt(round2(totals.nsSubtotal + shipping))})`);
    else if (cents(derived) !== cents(fieldsDiscount)) warn("discount_breakdown", `Desconto do pedido ${fmt(derived)} (subtotal + frete − total) difere da soma dos campos de desconto da Nuvemshop (${fmt(fieldsDiscount)})`);
  }
  const desconto = settings?.discountMode === "coupon" ? Math.max(0, totals.nsDiscount ?? 0) : 0;
  const frete = settings?.freightMode === "buyer_paid" ? round2(shipping) : 0;
  const despesas = 0;
  const total = round2(totals.itemsAds - desconto + frete + despesas);
  totals.adsTotal = total;
  if (total <= 0 && lines.length) block("invalid_total", "Total do pedido deve ser maior que zero");
  if (settings?.freightMode === "buyer_paid" && settings.discountMode === "coupon" && totals.nsTotal !== null && cents(total) !== cents(totals.nsTotal)) {
    block("paid_mismatch", `Total ADS (${fmt(total)}) difere do total pago na Nuvemshop (${fmt(totals.nsTotal)})`);
  } else if (totals.nsTotal !== null && cents(total) !== cents(totals.nsTotal)) {
    warn("paid_differs", `Total ADS (${fmt(total)}) difere do total pago na Nuvemshop (${fmt(totals.nsTotal)}) conforme as regras de frete/desconto configuradas`);
  }

  // Parcelas pelo prazo configurado (a ADS informa os dias).
  let parcelas: AdsOrderPayload["parcelas"] = [];
  if (settings) {
    const r = await adsCall<Record<string, unknown>[]>("GET", "prazos", { timeoutMs: 8_000 }).catch((err: Error) => ({ status: 0, data: null, durationMs: 0, error: err.message }));
    const listed = r.status === 200 && Array.isArray(r.data);
    const prazo = listed ? (r.data as Record<string, unknown>[]).find((p) => String(p.codigo ?? "").trim() === settings.prazoId) : undefined;
    if (!listed) block("ads_unavailable", `ADS indisponível ao consultar os prazos (${r.status ? `HTTP ${r.status}` : "sem resposta"})${adsProblem(r.data) ? `: ${adsProblem(r.data)}` : ""}; tente validar de novo em instantes`);
    else if (!prazo) block("prazo_unavailable", `Prazo ${settings.prazoId} não encontrado na ADS`);
    else {
      let base = o.createdAt ? new Date(o.createdAt) : new Date();
      if (settings.dueDateBase === "payment_approved") {
        if (o.paidAt) base = new Date(o.paidAt);
        else warn("no_approval_date", "Sem data de pagamento; vencimentos calculados a partir da data do pedido");
      }
      parcelas = buildInstallments(total, prazoDays(prazo), base);
    }
  }
  if (parcelas.length && cents(parcelas.reduce((a, p) => a + p.valor, 0)) !== cents(total)) block("installments_mismatch", "Soma das parcelas difere do total");

  const ref = o.number ?? orderId;
  const observacao = `Nuvemshop #${ref}`.slice(0, 50);
  const observacaoNF = `Pedido Nuvemshop #${ref} (id ${orderId})`.slice(0, 250);
  const pedidoCliente = String(ref).slice(0, 20);

  const ready = settings && billing?.docNumber && itens.length;
  const payload: AdsOrderPayload | null = ready
    ? {
        clienteId: customer?.adsClienteId ?? null,
        operacaoId: settings.operacaoId,
        clienteCnpjCpf: billing!.docNumber!,
        representanteId: settings.representanteId,
        formaDePagamentoId: settings.formaDePagamentoId,
        prazoId: settings.prazoId,
        desconto,
        frete,
        despesas,
        total,
        observacao,
        observacaoNF,
        pedidoCliente,
        idExterno: externalId,
        canalId: settings.canalId,
        tabela: settings.tabela,
        orcamento: false,
        especial: false,
        entrada: false,
        parcelas,
        itens,
      }
    : null;
  return {
    storeId,
    orderId,
    number: o.number,
    externalId,
    payload,
    payloadHash: payload ? canonicalHash(payload) : null,
    issues,
    ok: !!payload && !issues.some((i) => i.blocking),
    billing,
    customer,
    lines: outLines,
    totals,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Envio, conciliação e situação
// ---------------------------------------------------------------------------------------------------------------

export interface NsSubmission {
  id: string;
  orderId: string;
  externalId: string;
  environment: string;
  status: "SENDING" | "SENT" | "UNKNOWN" | "FAILED" | "CANCELED";
  adsPedidoId: number | null;
  adsStatus: string | null;
  attempts: number;
  requestedBy: string;
  lastError: string | null;
  sentAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = `id::text AS id, order_id::text AS "orderId", external_id AS "externalId", environment, status, ads_pedido_id AS "adsPedidoId",
  ads_status AS "adsStatus", attempts, requested_by AS "requestedBy", last_error AS "lastError", sent_at AS "sentAt",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function logNsAttempt(sql: Sql, storeId: string, orderId: string, submissionId: string | null, a: AttemptRecord): Promise<void> {
  await sql.execute(
    `INSERT INTO nuvemshop_ads_attempts (submission_id, store_id, order_id, operation, http_status, request, response, error, duration_ms, environment)
     VALUES ($1::uuid, $2, $3::bigint, $4, $5::int, $6::jsonb, $7::jsonb, $8, $9::int, $10)`,
    [
      submissionId,
      storeId,
      orderId,
      a.operation,
      a.status ?? null,
      a.request === undefined ? null : JSON.stringify(a.request),
      a.response === undefined ? null : JSON.stringify(a.response),
      a.error ? redactString(a.error).slice(0, 1000) : null,
      a.durationMs ?? null,
      adsEnvironment().environment,
    ],
  );
}

export async function listNsSubmissions(sql: Sql, storeId: string, orderId: string): Promise<NsSubmission[]> {
  return sql.query<NsSubmission>(`SELECT ${COLS} FROM nuvemshop_ads_submissions WHERE store_id = $1 AND order_id = $2::bigint ORDER BY created_at DESC`, [storeId, orderId]);
}

export async function listNsAttempts(sql: Sql, storeId: string, orderId: string) {
  return sql.query(
    `SELECT id::text AS id, submission_id::text AS "submissionId", operation, http_status AS "httpStatus", response, error, duration_ms AS "durationMs", created_at AS "createdAt"
     FROM nuvemshop_ads_attempts WHERE store_id = $1 AND order_id = $2::bigint ORDER BY id DESC LIMIT 100`,
    [storeId, orderId],
  );
}

async function activeNsSubmission(sql: Sql, storeId: string, orderId: string): Promise<NsSubmission | null> {
  const [s] = await sql.query<NsSubmission>(
    `SELECT ${COLS} FROM nuvemshop_ads_submissions WHERE store_id = $1 AND order_id = $2::bigint AND environment = $3 AND status IN ('SENDING', 'SENT', 'UNKNOWN')
     ORDER BY created_at LIMIT 1`,
    [storeId, orderId, adsEnvironment().environment],
  );
  return s ?? null;
}

const getSub = async (sql: Sql, id: string) => (await sql.query<NsSubmission>(`SELECT ${COLS} FROM nuvemshop_ads_submissions WHERE id = $1::uuid`, [id]))[0];

const matchesAny = (value: string | null, list: string[]) => !!value && list.some((s) => value.toLowerCase().includes(s.toLowerCase()));

/**
 * Leva a situação do envio para os compromissos de estoque do pedido (fatos ADS_ORDER_*; o Inventory Core decide
 * se a baixa já está refletida). Atualiza a situação do compromisso no pedido. Idempotente.
 */
export async function syncNsReservationsWithAds(sql: Sql, storeId: string, orderId: string): Promise<string | null> {
  const [sub] = await sql.query<NsSubmission>(
    `SELECT ${COLS} FROM nuvemshop_ads_submissions WHERE store_id = $1 AND order_id = $2::bigint AND environment = $3
     ORDER BY CASE WHEN status IN ('SENT', 'SENDING', 'UNKNOWN') THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    [storeId, orderId, adsEnvironment().environment],
  );
  if (!sub) return null;
  const settings = await getInventorySettings(sql);
  const at = sub.updatedAt ? new Date(sub.updatedAt) : new Date();
  const events: ReservationEvent[] = [];
  if (sub.status === "SENT") events.push({ type: "ADS_ORDER_CREATED", at });
  else if (sub.status === "SENDING" || sub.status === "UNKNOWN") events.push({ type: "ADS_ORDER_UNCERTAIN", at });
  else events.push({ type: "ADS_ORDER_FAILED", at });
  if (sub.status === "SENT" && /cancel/i.test(sub.adsStatus ?? "")) events.push({ type: "ADS_ORDER_CANCELLED" });
  else if (sub.status === "SENT" && matchesAny(sub.adsStatus, settings.adsReflectedStatuses)) events.push({ type: "ADS_STOCK_CONFIRMED" });
  const rows = await sql.query<{ lineKey: string; productId: number; quantity: string }>(
    `SELECT line_key AS "lineKey", product_id AS "productId", trim_scale(quantity)::text AS quantity FROM inventory_reservations
     WHERE channel = 'nuvemshop' AND external_order_id = $1 AND NOT simulated`,
    [orderId],
  );
  const correlationId = randomUUID();
  const states: string[] = [];
  for (const r of rows) {
    const res = await recordOrderEvents(
      sql,
      {
        channel: "nuvemshop",
        externalOrderId: orderId,
        lineKey: r.lineKey,
        productId: r.productId,
        quantity: Number(r.quantity),
        events,
        ads: { externalId: sub.externalId, pedidoId: sub.adsPedidoId, submissionStatus: sub.status, status: sub.adsStatus },
        correlationId,
        warehouseCode: settings.channelWarehouses.nuvemshop ?? "principal",
      },
      { adsDeductsOnOrderCreated: settings.adsDeductsOnOrderCreated },
    );
    states.push(res.state);
  }
  if (!rows.length) return null;
  const commitment = commitmentFromStates(states);
  await sql.execute(`UPDATE nuvemshop_orders SET commitment_state = $3, updated_at = now() WHERE store_id = $1 AND order_id = $2::bigint`, [storeId, orderId, commitment]);
  return commitment;
}

async function afterChange(sql: Sql, storeId: string, orderId: string) {
  await syncNsReservationsWithAds(sql, storeId, orderId).catch((err) => logger.error("Falha ao registrar o envio ADS nos compromissos de estoque", { orderId, error: (err as Error).message }));
}

/**
 * Envia o pedido. Exige validação sem bloqueios, o MESMO payload que o operador visualizou (hash) e escrita
 * liberada no ambiente ADS. A confirmação digitada é conferida na rota.
 */
export async function sendNsOrderToAds(sql: Sql, storeId: string, orderId: string, opts: { payloadHash: string; requestedBy: string }): Promise<NsSubmission> {
  assertAdsWriteAllowed();
  const env = adsEnvironment();
  const active = await activeNsSubmission(sql, storeId, orderId);
  if (active?.status === "SENT") return active;
  if (active?.status === "UNKNOWN") throw new SubmissionError("needs_reconcile", "Envio anterior com resultado incerto: consulte o resultado na ADS antes de qualquer reenvio");
  if (active?.status === "SENDING") throw new SubmissionError("in_progress", "Envio em andamento");

  const built = await buildNsAdsOrder(sql, storeId, orderId);
  if (!built.ok || !built.payload) throw new SubmissionError("not_valid", "Pedido não passou na validação", built.issues.filter((i) => i.blocking));
  if (built.payloadHash !== opts.payloadHash) throw new SubmissionError("payload_changed", "Os dados do pedido mudaram desde a visualização: valide e confira de novo antes de enviar");
  const sanitized = sanitizePayload(built.payload);

  const pre = await lookupByExternalId(built.externalId);
  await logNsAttempt(sql, storeId, orderId, null, { operation: "PRECHECK", status: pre.status, request: { idExterno: built.externalId }, response: pre.data, durationMs: pre.durationMs });
  if (pre.result === "unknown") throw new SubmissionError("precheck_failed", "Não foi possível confirmar na ADS se o pedido já existe; tente novamente em instantes");

  let submission: NsSubmission;
  try {
    [submission] = await sql.query<NsSubmission>(
      `INSERT INTO nuvemshop_ads_submissions (store_id, order_id, external_id, environment, status, payload, payload_hash, requested_by, ads_pedido_id, sent_at, completed_at)
       VALUES ($1, $2::bigint, $3, $4, $5, $6::jsonb, $7, $8, $9::int, now(), CASE WHEN $5::text = 'SENT' THEN now() END)
       RETURNING ${COLS}`,
      [storeId, orderId, built.externalId, env.environment, pre.result === "found" ? "SENT" : "SENDING", JSON.stringify(sanitized), built.payloadHash, opts.requestedBy, pre.pedidoId],
    );
  } catch (err) {
    if (/23505|unique/i.test((err as Error)?.message ?? "") || (err as { code?: string })?.code === "23505") throw new SubmissionError("in_progress", "Já existe um envio vigente para este pedido");
    throw err;
  }
  if (pre.result === "found") {
    await sql.execute(`UPDATE nuvemshop_ads_submissions SET last_error = 'Pedido já existia na ADS com este idExterno (nenhum POST enviado)' WHERE id = $1::uuid`, [submission.id]);
    logger.warn("Pedido Nuvemshop já existia na ADS; registrado sem novo POST", { orderId, pedidoId: pre.pedidoId });
    await afterChange(sql, storeId, orderId);
    return getSub(sql, submission.id);
  }

  await sql.execute(`UPDATE nuvemshop_ads_submissions SET attempts = attempts + 1, updated_at = now() WHERE id = $1::uuid`, [submission.id]);
  let next: { status: NsSubmission["status"]; pedidoId: number | null; error: string | null };
  try {
    const r = await adsCall<{ pedidoId?: number }>("POST", "pedidos", { body: built.payload, timeoutMs: 30_000 });
    await logNsAttempt(sql, storeId, orderId, submission.id, { operation: "POST", status: r.status, request: sanitized, response: r.data, durationMs: r.durationMs });
    const pedidoId = typeof r.data?.pedidoId === "number" && r.data.pedidoId > 0 ? r.data.pedidoId : null;
    if (r.status === 201 && pedidoId) next = { status: "SENT", pedidoId, error: null };
    else if (r.status === 201 || r.status >= 500) next = { status: "UNKNOWN", pedidoId: null, error: `Resposta sem confirmação (HTTP ${r.status}); conciliar pelo idExterno` };
    else next = { status: "FAILED", pedidoId: null, error: redactString(`ADS recusou o pedido (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 800)}`) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    await logNsAttempt(sql, storeId, orderId, submission.id, { operation: "POST", request: sanitized, error: msg });
    next = err instanceof AdsApiError && err.kind === "auth" ? { status: "FAILED", pedidoId: null, error: msg } : { status: "UNKNOWN", pedidoId: null, error: `${msg}: resultado incerto, conciliar pelo idExterno` };
  }
  await sql.execute(
    `UPDATE nuvemshop_ads_submissions SET status = $2, ads_pedido_id = $3::int, last_error = $4,
       completed_at = CASE WHEN $2::text IN ('SENT', 'FAILED') THEN now() END, updated_at = now() WHERE id = $1::uuid`,
    [submission.id, next.status, next.pedidoId, next.error],
  );
  logger.info("Envio de pedido Nuvemshop para a ADS", { orderId, submissionId: submission.id, status: next.status, pedidoId: next.pedidoId, environment: env.environment });
  await afterChange(sql, storeId, orderId);
  return getSub(sql, submission.id);
}

/** Concilia um envio incerto consultando o idExterno na ADS (nunca reenvia o POST). */
export async function reconcileNsSubmission(sql: Sql, storeId: string, orderId: string): Promise<NsSubmission> {
  const active = await activeNsSubmission(sql, storeId, orderId);
  if (!active) throw new SubmissionError("nothing_to_reconcile", "Nenhum envio vigente para conciliar");
  const r = await lookupByExternalId(active.externalId);
  await logNsAttempt(sql, storeId, orderId, active.id, { operation: "RECONCILE", status: r.status, request: { idExterno: active.externalId }, response: r.data, durationMs: r.durationMs });
  if (r.result === "found") {
    await sql.execute(
      `UPDATE nuvemshop_ads_submissions SET status = 'SENT', ads_pedido_id = $2::int, last_error = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1::uuid`,
      [active.id, r.pedidoId],
    );
  } else if (r.result === "not_found" && active.status !== "SENT") {
    await sql.execute(
      `UPDATE nuvemshop_ads_submissions SET status = 'FAILED', last_error = 'Conciliação: pedido não encontrado na ADS pelo idExterno; pode ser enviado novamente', completed_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [active.id],
    );
  }
  await afterChange(sql, storeId, orderId);
  return getSub(sql, active.id);
}

/** Situação do pedido na ADS (Em análise, Faturado...). Somente leitura. */
export async function refreshNsAdsStatus(sql: Sql, storeId: string, orderId: string): Promise<NsSubmission> {
  const active = await activeNsSubmission(sql, storeId, orderId);
  if (!active || active.status !== "SENT" || !active.adsPedidoId) throw new SubmissionError("not_sent", "Pedido ainda não confirmado na ADS");
  const r = await adsCall<{ pedidoId?: number; status?: string; nf?: number }[]>("GET", "pedidos/status", { query: { pedidoIds: [active.adsPedidoId] } });
  await logNsAttempt(sql, storeId, orderId, active.id, { operation: "STATUS", status: r.status, request: { pedidoIds: [active.adsPedidoId] }, response: r.data, durationMs: r.durationMs });
  const row = Array.isArray(r.data) ? r.data.find((x) => x.pedidoId === active.adsPedidoId) : undefined;
  if (row?.status) await sql.execute(`UPDATE nuvemshop_ads_submissions SET ads_status = $2, updated_at = now() WHERE id = $1::uuid`, [active.id, String(row.status).slice(0, 60)]);
  await afterChange(sql, storeId, orderId);
  return getSub(sql, active.id);
}

/** Lista de pedidos Nuvemshop com a situação do envio à ADS no ambiente atual (sem dados pessoais). */
export async function listNsOrdersForAds(sql: Sql, storeId: string, opts: { filter?: "pending" | "sent" | "all"; limit?: number } = {}) {
  const filter = opts.filter ?? "all";
  return sql.query(
    `SELECT o.order_id::text AS "orderId", o.number::text AS number, o.status, o.payment_status AS "paymentStatus", o.remote_created_at AS "createdAt",
            o.total::text AS total, o.lines, o.mapping_state AS "mappingState", o.commitment_state AS "commitmentState", o.unmapped_lines AS "unmappedLines",
            o.ads_confirmed_at AS "adsConfirmedAt", s.status AS "adsSubmission", s.ads_pedido_id AS "adsPedidoId", s.ads_status AS "adsStatus"
     FROM nuvemshop_orders o
     LEFT JOIN LATERAL (
       SELECT status, ads_pedido_id, ads_status FROM nuvemshop_ads_submissions x
       WHERE x.store_id = o.store_id AND x.order_id = o.order_id AND x.environment = $2
       ORDER BY CASE WHEN x.status IN ('SENT', 'SENDING', 'UNKNOWN') THEN 0 ELSE 1 END, x.created_at DESC LIMIT 1
     ) s ON true
     WHERE o.store_id = $1
       AND ($3::text = 'all'
         OR ($3::text = 'sent' AND s.status IN ('SENT', 'SENDING', 'UNKNOWN'))
         OR ($3::text = 'pending' AND COALESCE(s.status, 'NONE') NOT IN ('SENT', 'SENDING', 'UNKNOWN') AND COALESCE(o.status, '') <> 'cancelled'
             AND o.cancelled_at IS NULL AND o.ads_confirmed_at IS NULL))
     ORDER BY o.remote_created_at DESC NULLS LAST LIMIT $4`,
    [storeId, adsEnvironment().environment, filter, Math.min(500, opts.limit ?? 100)],
  );
}

/** Consulta o cliente na ADS pelo documento dos dados do comprador (somente leitura). */
export async function lookupNsCustomer(sql: Sql, storeId: string, orderId: string): Promise<AdsCustomer> {
  const billing = await getNsBilling(sql, storeId, orderId);
  if (!billing?.docNumber) throw new SubmissionError("no_billing", "Leia os dados do comprador antes (Reler pedido na Nuvemshop)");
  return lookupAdsCustomer(sql, billing.docNumber, null, nsCustomerContext(sql, storeId, orderId));
}

export { maskDocument };
