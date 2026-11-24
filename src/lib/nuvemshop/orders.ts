import "server-only";
import { randomUUID } from "node:crypto";
import { recordOrderEvents } from "../inventory/ingest";
import { audit } from "../inventory/ledger";
import type { ReservationEvent } from "../inventory/reservations";
import { getInventorySettings } from "../inventory/settings";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { AutomationError, getAutomation, type StockPolicy } from "./automation";
import { NuvemshopApiError, type NuvemshopApiClient } from "./client";
import { hasScope } from "./write-gate";

/**
 * Proteção mínima de estoque contra vendas Nuvemshop que ainda não chegaram ao ERP (Fase 2).
 *
 * - Pedidos chegam por webhook (order/created, order/updated) e por reconciliação periódica (GET /orders com
 *   updated_at_min), sempre relidos na API com autenticação (o webhook traz só o ID).
 * - Guardamos só o necessário: ID, número, situações, datas e linhas (variante, produto, quantidade, SKU). Nenhum
 *   nome, documento, contato ou endereço do comprador.
 * - Cada linha vira compromisso no Inventory Core (recordOrderEvents, canal "nuvemshop"): deduplicação por
 *   canal + pedido + linha + produto físico, kits expandidos pela composição do vínculo.
 * - Momento do compromisso: na CRIAÇÃO do pedido (padrão — a Nuvemshop já desconta o próprio estoque nesse
 *   momento e o pedido pode ser pago depois) ou no pagamento (política PAID). Cancelado = liberado.
 * - O envio à ADS é MANUAL (ads-orders.ts): o envio registra os fatos ADS_ORDER_* nos compromissos e a política do
 *   Inventory Core decide quando a baixa está refletida. Sem envio pelo integrador, o compromisso fica PENDING_ERP
 *   (descontado) até um administrador confirmar a baixa ("Baixa ADS confirmada"), quando passa a REFLECTED_IN_ERP e
 *   deixa de ser descontado — o desconto local nunca soma com a baixa da ADS (sem baixa dupla).
 * - Valores do pedido (subtotal, descontos, frete, total) e o preço de cada linha são guardados (sem dados pessoais);
 *   os dados fiscais do comprador só são lidos sob demanda, ao preparar o envio à ADS (ads-orders.ts).
 * - Leitura mais antiga que a gravada (updated_at menor) não substitui a mais nova.
 */
export const ORDER_FIELDS =
  "id,number,status,payment_status,shipping_status,created_at,updated_at,cancelled_at,paid_at,currency,gateway,subtotal,discount,discount_coupon,discount_gateway,total,products";

export interface NsOrder {
  id: number | string;
  number?: number | string | null;
  status?: string | null;
  payment_status?: string | null;
  shipping_status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  cancelled_at?: string | null;
  paid_at?: string | null;
  currency?: string | null;
  gateway?: string | null;
  subtotal?: number | string | null;
  discount?: number | string | null;
  discount_coupon?: number | string | null;
  discount_gateway?: number | string | null;
  shipping_cost_customer?: number | string | null;
  total?: number | string | null;
  products?: { id?: number | string; product_id?: number | string; variant_id?: number | string; quantity?: number | string; sku?: string | null; price?: number | string | null; name?: unknown }[] | null;
}

export interface OrderLine {
  lineId: string;
  productId: string | null;
  variantId: string | null;
  quantity: number;
  sku: string | null;
  /** Preço unitário na compra (null quando a leitura não trouxe o preço). */
  price?: number | null;
  name?: string | null;
}

/** Valor monetário da API ("125.50" ou 125.5) → número com 2 casas; ausente/inválido → null. */
export const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const textOf = (v: unknown): string | null => {
  const t = typeof v === "string" ? v : v && typeof v === "object" ? ((v as Record<string, unknown>).pt ?? Object.values(v as Record<string, unknown>)[0]) : null;
  return typeof t === "string" && t.trim() ? t.trim().slice(0, 120) : null;
};

const date = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function orderLines(o: NsOrder): OrderLine[] {
  return (o.products ?? []).map((p, i) => ({
    lineId: p?.id !== undefined && p?.id !== null ? String(p.id) : `idx${i}`,
    productId: p?.product_id !== undefined && p?.product_id !== null ? String(p.product_id) : null,
    variantId: p?.variant_id !== undefined && p?.variant_id !== null && String(p.variant_id) !== "" ? String(p.variant_id) : null,
    quantity: Math.max(0, Math.trunc(Number(p?.quantity ?? 0))),
    sku: typeof p?.sku === "string" && p.sku.trim() ? p.sku.trim().slice(0, 80) : null,
    price: money(p?.price),
    name: textOf(p?.name),
  }));
}

/** O pedido compromete estoque agora? (cancelado = não; PAID exige pagamento autorizado/pago). */
export function commitsStock(o: Pick<NsOrder, "status" | "payment_status" | "cancelled_at">, moment: StockPolicy["orderCommitMoment"]): { commit: boolean; cancelled: boolean } {
  const cancelled = o.status === "cancelled" || !!o.cancelled_at;
  if (cancelled) return { commit: false, cancelled: true };
  if (moment === "PAID") return { commit: ["paid", "authorized", "partially_paid"].includes(String(o.payment_status ?? "")), cancelled: false };
  return { commit: true, cancelled: false };
}

export interface UpsertOrderResult {
  orderId: string;
  stale: boolean;
  committed: boolean;
  cancelled: boolean;
  lines: number;
  unmapped: number;
  reservations: number;
}

/** Registra/atualiza um pedido e seus compromissos. Idempotente. */
export async function upsertOrder(sql: Sql, storeId: string, o: NsOrder, source: "WEBHOOK" | "RECONCILIATION" | "MANUAL", now = new Date()): Promise<UpsertOrderResult> {
  const orderId = String(o.id);
  if (!/^\d{1,20}$/.test(orderId)) throw new NuvemshopApiError("invalid_response", "Pedido sem id numérico");
  const updatedAt = date(o.updated_at);
  const [prev] = await sql.query<{ updatedAt: Date | null; commitment: string }>(
    `SELECT remote_updated_at AS "updatedAt", commitment_state AS commitment FROM nuvemshop_orders WHERE store_id = $1 AND order_id = $2::bigint`,
    [storeId, orderId],
  );
  if (prev?.updatedAt && updatedAt && new Date(updatedAt).getTime() < new Date(prev.updatedAt).getTime()) {
    return { orderId, stale: true, committed: false, cancelled: false, lines: 0, unmapped: 0, reservations: 0 };
  }
  const policy = (await getAutomation(sql, "STOCK")).policy;
  const settings = await getInventorySettings(sql);
  const lines = orderLines(o).filter((l) => l.quantity > 0);
  const { commit, cancelled } = commitsStock(o, policy.orderCommitMoment);
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => !!v))];
  const mappings = variantIds.length
    ? await sql.query<{ variantId: string; productId: number; components: { productId: number; quantity: number }[] | null }>(
        `SELECT m.variant_id::text AS "variantId", m.product_id AS "productId",
                (SELECT json_agg(json_build_object('productId', c.product_id, 'quantity', c.quantity)) FROM nuvemshop_mapping_components c WHERE c.mapping_id = m.id) AS components
         FROM nuvemshop_variant_mappings m WHERE m.store_id = $1 AND m.status = 'CONFIRMED' AND m.variant_id = ANY($2::bigint[])`,
        [storeId, variantIds],
      )
    : [];
  const byVariant = new Map(mappings.map((m) => [m.variantId, m.components?.length ? m.components : [{ productId: m.productId, quantity: 1 }]]));
  const correlationId = randomUUID();
  const events: ReservationEvent[] = [];
  if (commit || prev?.commitment === "COMMITTED" || prev?.commitment === "REQUIRES_RECONCILIATION" || prev?.commitment === "REFLECTED_IN_ERP") events.push({ type: "ORDER_RECEIVED", at: date(o.created_at) });
  if (cancelled) events.push({ type: "ORDER_CANCELLED", at: date(o.cancelled_at) ?? updatedAt });
  let unmapped = 0;
  const states: string[] = [];
  for (const l of lines) {
    const comps = l.variantId ? byVariant.get(l.variantId) : undefined;
    if (!comps) {
      unmapped++;
      continue;
    }
    if (!events.length) continue;
    for (const c of comps) {
      const r = await recordOrderEvents(
        sql,
        {
          channel: "nuvemshop",
          externalOrderId: orderId,
          lineKey: `L${l.lineId}`,
          productId: c.productId,
          quantity: l.quantity * c.quantity,
          events,
          orderCreatedAt: date(o.created_at) ? new Date(date(o.created_at)!) : null,
          sourceVersion: updatedAt ? new Date(updatedAt) : null,
          correlationId,
          warehouseCode: settings.channelWarehouses.nuvemshop ?? "principal",
        },
        { adsDeductsOnOrderCreated: settings.adsDeductsOnOrderCreated },
      );
      states.push(r.state);
    }
  }
  const mappingState = !lines.length || unmapped === lines.length ? "UNMAPPED" : unmapped ? "PARTIAL" : "MAPPED";
  const commitment = commitmentFromStates(states);
  // Leitura sem valores (campos não pedidos) não apaga os valores já conhecidos (COALESCE).
  await sql.execute(
    `INSERT INTO nuvemshop_orders (store_id, order_id, number, status, payment_status, shipping_status, cancelled_at, remote_created_at, remote_updated_at, lines,
       mapping_state, commitment_state, unmapped_lines, source, fetched_at, paid_at, currency, gateway, subtotal, discount, discount_coupon, discount_gateway,
       shipping_cost_customer, total)
     VALUES ($1, $2::bigint, $3::bigint, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::jsonb, $11, $12, $13, $14, $15::timestamptz,
       $16::timestamptz, $17, $18, $19::numeric, $20::numeric, $21::numeric, $22::numeric, $23::numeric, $24::numeric)
     ON CONFLICT (store_id, order_id) DO UPDATE SET number = EXCLUDED.number, status = EXCLUDED.status, payment_status = EXCLUDED.payment_status,
       shipping_status = EXCLUDED.shipping_status, cancelled_at = EXCLUDED.cancelled_at, remote_created_at = EXCLUDED.remote_created_at,
       remote_updated_at = EXCLUDED.remote_updated_at, lines = EXCLUDED.lines, mapping_state = EXCLUDED.mapping_state, commitment_state = EXCLUDED.commitment_state,
       unmapped_lines = EXCLUDED.unmapped_lines, source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at,
       paid_at = COALESCE(EXCLUDED.paid_at, nuvemshop_orders.paid_at), currency = COALESCE(EXCLUDED.currency, nuvemshop_orders.currency),
       gateway = COALESCE(EXCLUDED.gateway, nuvemshop_orders.gateway), subtotal = COALESCE(EXCLUDED.subtotal, nuvemshop_orders.subtotal),
       discount = COALESCE(EXCLUDED.discount, nuvemshop_orders.discount), discount_coupon = COALESCE(EXCLUDED.discount_coupon, nuvemshop_orders.discount_coupon),
       discount_gateway = COALESCE(EXCLUDED.discount_gateway, nuvemshop_orders.discount_gateway),
       shipping_cost_customer = COALESCE(EXCLUDED.shipping_cost_customer, nuvemshop_orders.shipping_cost_customer),
       total = COALESCE(EXCLUDED.total, nuvemshop_orders.total), updated_at = now()`,
    [
      storeId,
      orderId,
      o.number !== undefined && o.number !== null && /^\d+$/.test(String(o.number)) ? String(o.number) : null,
      o.status ?? null,
      o.payment_status ?? null,
      o.shipping_status ?? null,
      date(o.cancelled_at),
      date(o.created_at),
      updatedAt,
      JSON.stringify(lines),
      mappingState,
      commitment,
      unmapped,
      source,
      now.toISOString(),
      date(o.paid_at),
      typeof o.currency === "string" ? o.currency.slice(0, 3) : null,
      typeof o.gateway === "string" ? o.gateway.slice(0, 60) : null,
      money(o.subtotal),
      money(o.discount),
      money(o.discount_coupon),
      money(o.discount_gateway),
      money(o.shipping_cost_customer),
      money(o.total),
    ],
  );
  if (unmapped) logger.warn("Pedido Nuvemshop com linha sem vínculo ADS: aumentos de estoque do produto ficam bloqueados", { orderId, unmapped });
  return { orderId, stale: false, committed: commit, cancelled, lines: lines.length, unmapped, reservations: states.length };
}

/** Situação do pedido a partir dos estados dos compromissos das linhas. */
export function commitmentFromStates(states: string[]): string {
  return !states.length
    ? "NONE"
    : states.includes("REQUIRES_RECONCILIATION")
      ? "REQUIRES_RECONCILIATION"
      : states.includes("PENDING_ERP")
        ? "COMMITTED"
        : states.every((s) => s === "RELEASED")
          ? "RELEASED"
          : "REFLECTED_IN_ERP";
}

/**
 * Campos que a Nuvemshop recusa no filtro `fields` ("Invalid fields for this resource: a, b"). A lista responde
 * 404 com essa mensagem; o pedido avulso responde 500 sem dizer o campo (por isso shipping_cost_customer, recusado
 * em produção, não está em ORDER_FIELDS e só vem na leitura completa de refreshNsOrderForAds).
 */
export function invalidFieldsOf(err: unknown): string[] {
  if (!(err instanceof NuvemshopApiError)) return [];
  const m = /invalid fields for this resource:\s*([\w,\s]+)/i.exec(err.message);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Executa uma leitura com `fields`; se a Nuvemshop recusar algum campo, tenta de novo uma vez sem ele. */
export async function withFieldFallback<T>(fields: string, run: (fields: string) => Promise<T>): Promise<T> {
  try {
    return await run(fields);
  } catch (err) {
    const bad = invalidFieldsOf(err);
    const all = fields.split(",");
    const kept = all.filter((f) => !bad.includes(f));
    if (!bad.length || kept.length === all.length) throw err;
    logger.warn("Nuvemshop recusou campos do filtro fields; repetindo sem eles", { fields: bad });
    return run(kept.join(","));
  }
}

export async function fetchOrder(client: NuvemshopApiClient, orderId: string): Promise<NsOrder | null> {
  try {
    return await withFieldFallback(ORDER_FIELDS, async (fields) => (await client.get<NsOrder>(`/orders/${orderId}`, { fields })).data);
  } catch (err) {
    if (err instanceof NuvemshopApiError && err.kind === "not_found" && !invalidFieldsOf(err).length) return null;
    throw err;
  }
}

const CURSOR_KEY = "nuvemshop_orders_reconciliation";
const MAX_PAGES = 10;

interface Cursor {
  updatedAtMin: string | null;
  lastRunAt: string | null;
  lastCompleteAt: string | null;
  lastError: string | null;
  orders: number;
}

export async function getOrderCursor(sql: Sql): Promise<Cursor> {
  const [row] = await sql.query<{ value: Partial<Cursor> }>(`SELECT value FROM app_settings WHERE key = $1`, [CURSOR_KEY]);
  return { updatedAtMin: null, lastRunAt: null, lastCompleteAt: null, lastError: null, orders: 0, ...(row?.value ?? {}) };
}

async function saveCursor(sql: Sql, c: Cursor) {
  await sql.execute(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [CURSOR_KEY, JSON.stringify(c)]);
}

/**
 * Reconciliação de pedidos (rede de segurança para webhooks atrasados/perdidos): pedidos alterados desde o
 * último cursor (com 10 min de sobreposição). Primeira execução: janela de orderLookbackDays.
 */
export async function reconcileOrders(sql: Sql, client: NuvemshopApiClient, storeId: string, opts: { deadline?: number; now?: Date } = {}): Promise<{ orders: number; complete: boolean; unmapped: number }> {
  const now = opts.now ?? new Date();
  const cursor = await getOrderCursor(sql);
  const settings = await getInventorySettings(sql);
  const since = cursor.updatedAtMin ? new Date(new Date(cursor.updatedAtMin).getTime() - 10 * 60_000) : new Date(now.getTime() - settings.orderLookbackDays * 86_400_000);
  let orders = 0;
  let unmapped = 0;
  let complete = false;
  let maxUpdated = cursor.updatedAtMin ? new Date(cursor.updatedAtMin).getTime() : since.getTime();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (opts.deadline && Date.now() > opts.deadline - 5_000) break;
      const res = await withFieldFallback(ORDER_FIELDS, (fields) => client.getPage<NsOrder>("/orders", page, 200, { updated_at_min: since.toISOString(), fields }));
      for (const o of res.items) {
        const r = await upsertOrder(sql, storeId, o, "RECONCILIATION", now);
        orders++;
        unmapped += r.unmapped;
        const u = date(o.updated_at);
        if (u) maxUpdated = Math.max(maxUpdated, new Date(u).getTime());
      }
      if (!res.hasNext) {
        complete = true;
        break;
      }
    }
    await markStalePending(sql, storeId, now);
    await saveCursor(sql, { updatedAtMin: new Date(maxUpdated).toISOString(), lastRunAt: now.toISOString(), lastCompleteAt: complete ? now.toISOString() : cursor.lastCompleteAt, lastError: null, orders });
  } catch (err) {
    await saveCursor(sql, { ...cursor, lastRunAt: now.toISOString(), lastError: (err as Error).message?.slice(0, 300) ?? "erro" });
    throw err;
  }
  return { orders, complete, unmapped };
}

/** Pendentes há mais de pendingReconcileAfterDays sem evidência de baixa → REQUIRES_RECONCILIATION (continua descontado). */
async function markStalePending(sql: Sql, storeId: string, now: Date) {
  const settings = await getInventorySettings(sql);
  const stale = await sql.query<{ orderId: string; lineKey: string; productId: number; quantity: string }>(
    `SELECT external_order_id AS "orderId", line_key AS "lineKey", product_id AS "productId", trim_scale(quantity)::text AS quantity FROM inventory_reservations
     WHERE channel = 'nuvemshop' AND state = 'PENDING_ERP' AND NOT simulated AND order_created_at < $1::timestamptz LIMIT 200`,
    [new Date(now.getTime() - settings.pendingReconcileAfterDays * 86_400_000).toISOString()],
  );
  const correlationId = randomUUID();
  for (const s of stale) {
    await recordOrderEvents(
      sql,
      { channel: "nuvemshop", externalOrderId: s.orderId, lineKey: s.lineKey, productId: s.productId, quantity: Number(s.quantity), events: [{ type: "STALE_PENDING" }], correlationId, warehouseCode: settings.channelWarehouses.nuvemshop ?? "principal" },
      { adsDeductsOnOrderCreated: settings.adsDeductsOnOrderCreated },
    );
    await sql.execute(`UPDATE nuvemshop_orders SET commitment_state = 'REQUIRES_RECONCILIATION', updated_at = now() WHERE store_id = $1 AND order_id = $2::bigint AND commitment_state = 'COMMITTED'`, [storeId, s.orderId]);
  }
}

/**
 * Liberação controlada: o administrador confirma que a venda já foi baixada na ADS. Os compromissos passam a
 * REFLECTED_IN_ERP e deixam de ser descontados (a ADS já desconta no saldo).
 */
export async function confirmAdsReflection(sql: Sql, input: { storeId: string; orderId: string; actor: string; reference?: string | null }): Promise<{ lines: number }> {
  const [order] = await sql.query<{ orderId: string; commitment: string }>(
    `SELECT order_id::text AS "orderId", commitment_state AS commitment FROM nuvemshop_orders WHERE store_id = $1 AND order_id = $2::bigint`,
    [input.storeId, input.orderId],
  );
  if (!order) throw new AutomationError("order_not_found", "Pedido Nuvemshop não encontrado", 404);
  if (order.commitment !== "COMMITTED" && order.commitment !== "REQUIRES_RECONCILIATION") throw new AutomationError("not_pending", "O pedido não tem compromisso pendente de baixa na ADS");
  const settings = await getInventorySettings(sql);
  const rows = await sql.query<{ lineKey: string; productId: number; quantity: string }>(
    `SELECT line_key AS "lineKey", product_id AS "productId", trim_scale(quantity)::text AS quantity FROM inventory_reservations
     WHERE channel = 'nuvemshop' AND external_order_id = $1 AND state IN ('PENDING_ERP', 'REQUIRES_RECONCILIATION') AND NOT simulated`,
    [input.orderId],
  );
  const correlationId = randomUUID();
  for (const r of rows) {
    await recordOrderEvents(
      sql,
      { channel: "nuvemshop", externalOrderId: input.orderId, lineKey: r.lineKey, productId: r.productId, quantity: Number(r.quantity), events: [{ type: "ADS_STOCK_CONFIRMED" }], ads: { status: "CONFIRMADO_MANUALMENTE" }, correlationId, warehouseCode: settings.channelWarehouses.nuvemshop ?? "principal" },
      { adsDeductsOnOrderCreated: settings.adsDeductsOnOrderCreated },
    );
  }
  await sql.execute(
    `UPDATE nuvemshop_orders SET commitment_state = 'REFLECTED_IN_ERP', ads_confirmed_by = $3, ads_confirmed_at = now(), ads_reference = $4, updated_at = now() WHERE store_id = $1 AND order_id = $2::bigint`,
    [input.storeId, input.orderId, input.actor, input.reference?.slice(0, 80) ?? null],
  );
  await audit(sql, { actor: input.actor, action: "NS_ORDER_ADS_CONFIRMED", entityType: "nuvemshop_order", entityId: input.orderId, after: { lines: rows.length, reference: input.reference ?? null } });
  return { lines: rows.length };
}

export interface OrderProtectionState {
  ready: boolean;
  reasons: string[];
  lastReconciliationAt: string | null;
  webhooks: string[];
}

/**
 * A proteção de pedidos está operante? Exige: escopo read_orders, webhooks de pedido ativos e uma reconciliação
 * concluída recentemente (até 3× o intervalo configurado). Sem isso, aumentos de estoque ficam bloqueados.
 */
export async function orderProtectionState(sql: Sql, store: { storeId: string; grantedScopes: string | null }, now = new Date()): Promise<OrderProtectionState> {
  const reasons: string[] = [];
  const policy = (await getAutomation(sql, "STOCK")).policy;
  if (!hasScope(store.grantedScopes, "read_orders", "write_orders")) reasons.push("Escopo read_orders não concedido pela loja");
  const hooks = await sql.query<{ event: string }>(`SELECT event FROM nuvemshop_webhook_registrations WHERE store_id = $1 AND status = 'ACTIVE'`, [store.storeId]);
  const events = hooks.map((h) => h.event);
  for (const e of ["order/created", "order/updated"]) if (!events.includes(e)) reasons.push(`Webhook ${e} não cadastrado`);
  const cursor = await getOrderCursor(sql);
  const maxAge = policy.orderReconcileMinutes * 3 * 60_000;
  if (!cursor.lastCompleteAt) reasons.push("Nenhuma reconciliação de pedidos concluída ainda");
  else if (now.getTime() - new Date(cursor.lastCompleteAt).getTime() > maxAge) reasons.push(`Última reconciliação de pedidos concluída há mais de ${policy.orderReconcileMinutes * 3} min`);
  return { ready: reasons.length === 0, reasons, lastReconciliationAt: cursor.lastCompleteAt, webhooks: events };
}

/** Produtos ADS com venda Nuvemshop sem baixa confirmada além do prazo (bloqueio de aumento). */
export async function productsWithUnconfirmedOrders(sql: Sql, graceHours: number, now = new Date()): Promise<Map<number, number>> {
  const rows = await sql.query<{ productId: number; n: number }>(
    `SELECT product_id AS "productId", count(*)::int AS n FROM inventory_reservations
     WHERE channel = 'nuvemshop' AND NOT simulated AND (state = 'REQUIRES_RECONCILIATION' OR (state = 'PENDING_ERP' AND COALESCE(order_created_at, created_at) < $1::timestamptz))
     GROUP BY product_id`,
    [new Date(now.getTime() - graceHours * 3_600_000).toISOString()],
  );
  return new Map(rows.map((r) => [r.productId, r.n]));
}

/** Produtos Nuvemshop (product_id da loja) com linhas de pedido recentes sem vínculo ADS. */
export async function nsProductsWithUnmappedOrders(sql: Sql, storeId: string, days = 7): Promise<Set<string>> {
  const rows = await sql.query<{ lines: { productId: string | null; variantId: string | null }[] }>(
    `SELECT lines FROM nuvemshop_orders WHERE store_id = $1 AND unmapped_lines > 0 AND commitment_state <> 'RELEASED' AND COALESCE(status, '') <> 'cancelled'
       AND remote_created_at > now() - make_interval(days => $2::int)`,
    [storeId, days],
  );
  const mapped = await sql.query<{ variantId: string }>(`SELECT variant_id::text AS "variantId" FROM nuvemshop_variant_mappings WHERE store_id = $1 AND status = 'CONFIRMED'`, [storeId]);
  const ok = new Set(mapped.map((m) => m.variantId));
  const out = new Set<string>();
  for (const r of rows) for (const l of r.lines ?? []) if (l.productId && (!l.variantId || !ok.has(l.variantId))) out.add(l.productId);
  return out;
}

export async function listOrders(sql: Sql, storeId: string, opts: { state?: string | null; limit?: number } = {}) {
  return sql.query(
    `SELECT order_id::text AS "orderId", number::text AS number, status, payment_status AS "paymentStatus", cancelled_at AS "cancelledAt", remote_created_at AS "createdAt",
            remote_updated_at AS "updatedAt", lines, mapping_state AS "mappingState", commitment_state AS "commitmentState", unmapped_lines AS "unmappedLines",
            ads_confirmed_by AS "adsConfirmedBy", ads_confirmed_at AS "adsConfirmedAt", ads_reference AS "adsReference", source
     FROM nuvemshop_orders WHERE store_id = $1 AND ($2::text IS NULL OR commitment_state = $2) ORDER BY remote_created_at DESC NULLS LAST LIMIT $3`,
    [storeId, opts.state ?? null, Math.min(500, opts.limit ?? 100)],
  );
}
