import "server-only";
import { createHash } from "node:crypto";
import { getOrderBilling, maskDocument, validDocument, type StoredBilling } from "../marketplace/billing";
import type { Sql } from "../sql";
import { adsCall, adsEnvironment, adsProblem } from "./client";
import { getAdsOrderSettings, prazoDays, type AdsOrderSettings } from "./commercial";
import { getAdsCustomer, type AdsCustomer } from "./customers";
import { externalIdForGroup, resolveOrderGroup, type OrderGroup } from "./order-group";

/**
 * Converte um pedido do Mercado Livre no corpo de POST /api/v1/{cnpjDistribuidora}/pedidos.
 * Pedido avulso (ou pack de um pedido só): um pedido ADS por order_id ("M" + order_id).
 * Pack com vários pedidos (compra no carrinho): UM pedido ADS com os itens de todos ("P" + pack_id),
 * frete contado uma vez por envio — ver order-group.ts. Qualquer inconsistência gera um problema "bloqueante".
 */
export interface Issue {
  code: string;
  message: string;
  blocking: boolean;
}

export interface AdsOrderItem {
  produtoId: number;
  categoria: string;
  codigoTabelaDePreco: string | null;
  quantidade: number;
  precoUnitario: number;
  precoTabela: number;
  percentualDesconto: number;
  valorLiquido: number;
  observacao: string | null;
}

export interface AdsOrderPayload {
  clienteId: number | null;
  operacaoId: string | null;
  clienteCnpjCpf: string;
  representanteId: string | null;
  formaDePagamentoId: string;
  prazoId: string;
  desconto: number;
  frete: number;
  despesas: number;
  total: number;
  observacao: string | null;
  observacaoNF: string | null;
  pedidoCliente: string;
  idExterno: string;
  canalId: string;
  tabela: string;
  orcamento: boolean;
  especial: boolean;
  entrada: boolean;
  parcelas: { parcela: number; vencimento: string; valor: number }[];
  itens: AdsOrderItem[];
}

export interface BuildResult {
  orderInboxId: string;
  marketplaceOrderId: string;
  packId: string | null;
  externalId: string;
  payload: AdsOrderPayload | null;
  payloadHash: string | null;
  issues: Issue[];
  ok: boolean;
  billing: StoredBilling | null;
  customer: AdsCustomer | null;
  /** Pedidos ML incluídos neste pedido ADS (mais de um quando é um pack). */
  group: OrderGroup;
  totals: { itemsAds: number; itemsMl: number; mlTotal: number | null; mlPaid: number | null; adsTotal: number | null };
}

const cents = (n: number) => Math.round(n * 100);
const round2 = (n: number) => cents(n) / 100;

export { externalIdFor, externalIdForPack } from "./order-group";

/** Serialização canônica (chaves ordenadas) para o hash do payload que o operador aprovou. */
export function canonicalHash(v: unknown): string {
  const canon = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(canon) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])])) : x;
  return createHash("sha256").update(JSON.stringify(canon(v))).digest("hex");
}

/** Payload para exibição/registro: documento mascarado. */
export function sanitizePayload(p: AdsOrderPayload | null): unknown {
  return p ? { ...p, clienteCnpjCpf: maskDocument(p.clienteCnpjCpf) } : null;
}

function addDays(base: Date, days: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, 12));
  return d.toISOString();
}

/** Divide o total nas parcelas do prazo (centavos que sobram vão para a última). */
export function buildInstallments(total: number, days: number[], base: Date): { parcela: number; vencimento: string; valor: number }[] {
  const list = days.length ? days : [0];
  const totalC = cents(total);
  const each = Math.floor(totalC / list.length);
  return list.map((d, i) => ({ parcela: i + 1, vencimento: addDays(base, d), valor: (i === list.length - 1 ? totalC - each * (list.length - 1) : each) / 100 }));
}

type MemberRow = {
  id: string;
  orderId: string;
  packId: string | null;
  buyerId: string | null;
  orderStatus: string | null;
  paymentStatus: string | null;
  discountAmount: string | null;
  shippingAmount: string | null;
  totalAmount: string | null;
  paidAmount: string | null;
  shipmentId: string | null;
  dateCreated: Date | null;
};

const sumOrNull = (values: (string | null)[]) => (values.some((v) => v === null) ? null : round2(values.reduce((a, v) => a + Number(v), 0)));

/**
 * Frete do pack: o pagamento de cada pedido informa o frete pago (sem repetir o mesmo pagamento);
 * sem frete nos pagamentos, o valor vem do envio — que é COMPARTILHADO pelos pedidos do pack e
 * por isso entra uma vez por envio, não uma vez por pedido.
 */
function packFreight(members: MemberRow[], payments: { paymentId: string; shippingCost: string | null }[]): number {
  const seen = new Map<string, number>();
  for (const p of payments) seen.set(p.paymentId, Number(p.shippingCost ?? 0));
  const fromPayments = [...seen.values()].reduce((a, v) => a + v, 0);
  if (fromPayments > 0) return round2(fromPayments);
  const byShipment = new Map<string, number>();
  for (const m of members) {
    const key = m.shipmentId ? `s:${m.shipmentId}` : `o:${m.id}`;
    byShipment.set(key, Math.max(byShipment.get(key) ?? 0, Number(m.shippingAmount ?? 0)));
  }
  return round2([...byShipment.values()].reduce((a, v) => a + v, 0));
}

export async function buildAdsOrder(sql: Sql, orderInboxId: string, opts: { settings?: AdsOrderSettings | null; group?: OrderGroup } = {}): Promise<BuildResult> {
  const issues: Issue[] = [];
  const block = (code: string, message: string) => issues.push({ code, message, blocking: true });
  const warn = (code: string, message: string) => issues.push({ code, message, blocking: false });

  const group = opts.group ?? (await resolveOrderGroup(sql, orderInboxId));
  for (const i of group.issues) block(i.code, i.message);
  const members = await sql.query<MemberRow>(
    `SELECT id::text AS id, marketplace_order_id AS "orderId", pack_id AS "packId", buyer_id AS "buyerId", order_status AS "orderStatus",
            payment_status AS "paymentStatus", discount_amount::text AS "discountAmount", shipping_amount::text AS "shippingAmount",
            total_amount::text AS "totalAmount", paid_amount::text AS "paidAmount", shipment_id AS "shipmentId", date_created AS "dateCreated"
     FROM marketplace_order_inbox WHERE id = ANY($1::bigint[])`,
    [group.memberIds],
  );
  members.sort((a, b) => group.memberIds.indexOf(a.id) - group.memberIds.indexOf(b.id));
  const o = members.find((m) => m.id === group.leadId);
  if (!o) throw new Error("Pedido não encontrado");
  const externalId = externalIdForGroup(group);
  const settings = opts.settings === undefined ? await getAdsOrderSettings(sql) : opts.settings;
  // Dados fiscais do comprador: no pedido principal do pack.
  const billing = await getOrderBilling(sql, group.leadId);
  const customer = billing?.docNumber ? await getAdsCustomer(sql, billing.docNumber) : null;
  const totals: BuildResult["totals"] = {
    itemsAds: 0,
    itemsMl: 0,
    mlTotal: sumOrNull(members.map((m) => m.totalAmount)),
    mlPaid: sumOrNull(members.map((m) => m.paidAmount)),
    adsTotal: null,
  };

  // Situação de cada pedido e pagamento.
  for (const m of members) {
    const label = group.isPack ? `Pedido ${m.orderId} do pack` : "Pedido";
    if (m.orderStatus === "cancelled" || m.orderStatus === "invalid") block("order_cancelled", `${label} ${m.orderStatus === "cancelled" ? "cancelado" : "inválido"} no Mercado Livre`);
    const payment = `agamento não aprovado (situação: ${m.paymentStatus ?? "desconhecida"})`;
    if (m.paymentStatus !== "approved") block("payment_not_approved", group.isPack ? `${label}: p${payment}` : `P${payment}`);
  }

  if (group.isPack) {
    if (new Set(members.map((m) => m.buyerId)).size > 1) block("pack_buyer_mismatch", "Pedidos do pack com compradores diferentes");
    const docs = await sql.query<{ doc: string }>(
      `SELECT DISTINCT doc_number AS doc FROM marketplace_order_billing WHERE order_id = ANY($1::bigint[]) AND doc_number IS NOT NULL`,
      [group.memberIds],
    );
    if (docs.length > 1) block("pack_buyer_mismatch", "Pedidos do pack com CPF/CNPJ diferentes nos dados fiscais");
    const shipments = new Set(members.map((m) => m.shipmentId).filter(Boolean));
    if (shipments.size > 1) warn("pack_multiple_shipments", `O Mercado Livre dividiu o pack em ${shipments.size} envios; a ADS recebe um pedido só`);
    // Pedido do pack que já foi enviado sozinho (antes do envio por pack): não envia de novo.
    const sent = await sql.query<{ orderId: string; externalId: string; adsPedidoId: number | null }>(
      `SELECT marketplace_order_id AS "orderId", external_id AS "externalId", ads_pedido_id AS "adsPedidoId" FROM ads_order_submissions
       WHERE order_id = ANY($1::bigint[]) AND environment = $2::text AND status IN ('SENDING', 'SENT', 'UNKNOWN') AND external_id <> $3::text`,
      [group.memberIds, adsEnvironment().environment, externalId],
    );
    for (const s of sent) {
      block("pack_member_sent", `Pedido ${s.orderId} já foi enviado sozinho à ADS (idExterno ${s.externalId}${s.adsPedidoId ? `, pedido ADS ${s.adsPedidoId}` : ""}); o restante do pack precisa ser lançado direto no ADSNET`);
    }
  }

  // Configuração comercial.
  if (!settings) block("settings_missing", "Configuração comercial da ADS não definida (Configurações › Pedidos ADS)");

  // Comprador.
  if (!billing) block("billing_missing", "Dados fiscais do comprador ainda não consultados");
  else if (billing.status !== "COMPLETE") {
    const docOk = billing.docNumber && validDocument(billing.docNumber);
    (docOk ? warn : block)("billing_incomplete", `Dados fiscais incompletos: ${billing.missing.join(", ")}`);
  }
  if (billing?.docNumber && !validDocument(billing.docNumber)) block("document_invalid", "CPF/CNPJ do comprador inválido");
  if (billing?.docNumber && (!customer || (customer.status !== "FOUND" && customer.status !== "CREATED") || !customer.adsClienteId)) {
    block("customer_not_identified", customer?.status === "AMBIGUOUS" ? "Mais de um cliente com o mesmo documento na ADS" : "Cliente não identificado na ADS (consulte ou cadastre)");
  }
  // A ADS cadastra clientes vindos da API como inativos e a API não permite ativar: o operador ativa no ADSNET.
  if (customer?.adsClienteId && customer.lastError === "Cliente inativo na ADS") {
    warn("customer_inactive", `Cliente ${customer.adsClienteId} está INATIVO na ADS: ative no ADSNET (Clientes › Alterar) e clique em "Consultar cliente na ADS de novo" antes de enviar`);
  }

  // Itens.
  const lines = await sql.query<{ lineKey: string; itemId: string; title: string | null; quantity: string; unitPrice: string | null; mapping: string; productId: number | null; adsProductId: number | null }>(
    `SELECT line_key AS "lineKey", marketplace_item_id AS "itemId", title, quantity::text AS quantity, unit_price::text AS "unitPrice",
            mapping_status AS mapping, product_id AS "productId", ads_product_id AS "adsProductId"
     FROM marketplace_order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id`,
    [group.memberIds],
  );
  if (!lines.length) block("no_items", "Pedido sem itens");
  const unmapped = lines.filter((l) => l.mapping !== "MAPPED" || !l.adsProductId);
  if (unmapped.length) block("unmapped_items", `${unmapped.length} item(ns) sem produto ADS: ${unmapped.map((l) => l.itemId).join(", ")}`);

  const byProduct = new Map<number, { quantity: number; unitPrice: number; productId: number | null; lines: string[] }>();
  for (const l of lines) {
    const q = Number(l.quantity);
    const p = Number(l.unitPrice ?? 0);
    totals.itemsMl += q * p;
    if (!(q > 0)) block("invalid_quantity", `Quantidade inválida no item ${l.itemId}`);
    if (!(p > 0)) block("invalid_price", `Preço unitário inválido no item ${l.itemId}`);
    if (!l.adsProductId) continue;
    const cur = byProduct.get(l.adsProductId);
    if (cur && cents(cur.unitPrice) !== cents(p)) block("conflicting_prices", `Produto ADS ${l.adsProductId} vendido com preços diferentes no mesmo ${group.isPack ? "pack" : "pedido"}`);
    else if (cur) {
      cur.quantity += q;
      cur.lines.push(l.lineKey);
    } else byProduct.set(l.adsProductId, { quantity: q, unitPrice: p, productId: l.productId, lines: [l.lineKey] });
  }

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
  totals.itemsMl = round2(totals.itemsMl);

  // Totais: itens do ADS = itens vendidos no ML = total de produtos do pedido ML.
  if (!unmapped.length && cents(totals.itemsAds) !== cents(totals.itemsMl)) block("items_total_mismatch", `Soma dos itens (${totals.itemsAds}) difere do vendido no ML (${totals.itemsMl})`);
  if (totals.mlTotal !== null && cents(totals.itemsMl) !== cents(totals.mlTotal)) block("ml_total_mismatch", `Itens (${totals.itemsMl}) diferem do total do pedido no ML (${totals.mlTotal})`);

  const payments = await sql.query<{ paymentId: string; shippingCost: string | null }>(
    `SELECT payment_id AS "paymentId", shipping_cost::text AS "shippingCost" FROM marketplace_order_payments WHERE order_id = ANY($1::bigint[])`,
    [group.memberIds],
  );
  const shipping = group.isPack ? packFreight(members, payments) : round2(Number(o.shippingAmount ?? 0));
  const desconto = settings?.discountMode === "coupon" ? round2(members.reduce((a, m) => a + Number(m.discountAmount ?? 0), 0)) : 0;
  const frete = settings?.freightMode === "buyer_paid" ? shipping : 0;
  const despesas = 0;
  const total = round2(totals.itemsAds - desconto + frete + despesas);
  totals.adsTotal = total;
  if (total <= 0 && lines.length) block("invalid_total", "Total do pedido deve ser maior que zero");
  if (settings?.freightMode === "buyer_paid" && settings.discountMode === "coupon" && totals.mlPaid !== null && cents(total) !== cents(totals.mlPaid)) {
    block("paid_mismatch", `Total ADS (${total}) difere do valor pago no ML (${totals.mlPaid})`);
  } else if (totals.mlPaid !== null && cents(total) !== cents(totals.mlPaid)) {
    warn("paid_differs", `Total ADS (${total}) difere do valor pago pelo comprador no ML (${totals.mlPaid}) conforme as regras de frete/desconto configuradas`);
  }

  // Parcelas pelo prazo configurado (consulta a ADS para obter os dias).
  let parcelas: AdsOrderPayload["parcelas"] = [];
  if (settings) {
    const r = await adsCall<Record<string, unknown>[]>("GET", "prazos", { timeoutMs: 8_000 }).catch((err: Error) => ({ status: 0, data: null, durationMs: 0, error: err.message }));
    const listed = r.status === 200 && Array.isArray(r.data);
    const prazo = listed ? (r.data as Record<string, unknown>[]).find((p) => String(p.codigo ?? "").trim() === settings.prazoId) : undefined;
    if (!listed) block("ads_unavailable", `ADS indisponível ao consultar os prazos (${r.status ? `HTTP ${r.status}` : "sem resposta"})${adsProblem(r.data) ? `: ${adsProblem(r.data)}` : ""}; tente validar de novo em instantes`);
    else if (!prazo) block("prazo_unavailable", `Prazo ${settings.prazoId} não encontrado na ADS`);
    else {
      let base = o.dateCreated ? new Date(o.dateCreated) : new Date();
      if (settings.dueDateBase === "payment_approved") {
        const [p] = await sql.query<{ approved: Date | null }>(
          `SELECT max(date_approved) AS approved FROM marketplace_order_payments WHERE order_id = ANY($1::bigint[]) AND status = 'approved'`,
          [group.memberIds],
        );
        if (p?.approved) base = new Date(p.approved);
        else warn("no_approval_date", "Sem data de aprovação do pagamento; vencimentos calculados a partir da data da venda");
      }
      parcelas = buildInstallments(total, prazoDays(prazo), base);
    }
  }
  if (parcelas.length && cents(parcelas.reduce((a, p) => a + p.valor, 0)) !== cents(total)) block("installments_mismatch", "Soma das parcelas difere do total");

  const orderIds = members.map((m) => m.orderId);
  const observacao = (group.isPack ? `ML pack ${group.packId}` : `ML ${o.orderId}${o.packId ? ` pack ${o.packId}` : ""}`).slice(0, 50);
  const observacaoNF = (
    group.isPack ? `Pedido Mercado Livre pack ${group.packId} (pedidos ${orderIds.join(", ")})` : `Pedido Mercado Livre ${o.orderId}${o.packId ? ` (pack ${o.packId})` : ""}`
  ).slice(0, 250);
  const reference = group.isPack ? group.packId! : o.orderId;
  const pedidoCliente = reference.slice(0, 20);
  if (reference.length > 20) warn("order_id_truncated", "Número do pedido ML truncado em pedidoCliente (20)");

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
    orderInboxId,
    marketplaceOrderId: o.orderId,
    packId: o.packId,
    externalId,
    payload,
    payloadHash: payload ? canonicalHash(payload) : null,
    issues,
    ok: !!payload && !issues.some((i) => i.blocking),
    billing,
    customer,
    group,
    totals,
  };
}
