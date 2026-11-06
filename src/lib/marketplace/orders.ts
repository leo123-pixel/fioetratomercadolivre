import "server-only";
import { adsEnvironment } from "../ads/client";
import { MeliHttpError, meliRequest } from "../meli/api";
import { getStore } from "../store";
import type { Sql } from "../sql";
import { getMarketplaceConfig } from "./config";
import { PermanentEventError, withReadRetry } from "./errors";
import { enqueueDerived } from "./events";
import { resolveProduct, type Resolved } from "./mappings";
import { adsStatusOf, mappingStatusOf } from "./order-status";

/**
 * Pedidos do Mercado Livre — SOMENTE recepção, consulta e armazenamento (fase 5).
 * Nada aqui envia pedidos à ADS nem altera pedidos no ML. READY_FOR_ADS significa apenas que os
 * dados essenciais estão preparados para a próxima fase.
 *
 * Vínculo dos itens com o catálogo, em ordem de confiança (nunca por semelhança de título):
 *   1. LISTING      — o item vendido é um anúncio publicado por este integrador (marketplace_listings).
 *   2. USER_PRODUCT — o user_product_id do item corresponde a um anúncio publicado.
 *   3. SELLER_SKU   — o SKU do vendedor é "ADS-<produtoId>" (padrão gravado na publicação) e o produto existe.
 *   Sem correspondência confiável → UNMAPPED (tratamento manual).
 */
export { ADS_STATUSES, ADS_VIEW_STATUSES, adsStatusOf } from "./order-status";

interface MeliOrderItem {
  item?: { id?: string; title?: string; seller_sku?: string | null; variation_id?: number | string | null; category_id?: string; user_product_id?: string | null };
  quantity?: number;
  unit_price?: number;
  full_unit_price?: number;
  sale_fee?: number;
  currency_id?: string;
}

interface MeliPayment {
  id?: number | string;
  status?: string;
  status_detail?: string;
  payment_type?: string;
  payment_method_id?: string;
  installments?: number;
  transaction_amount?: number;
  total_paid_amount?: number;
  shipping_cost?: number;
  coupon_amount?: number;
  date_created?: string;
  date_approved?: string;
  date_last_modified?: string;
}

export interface MeliOrder {
  id?: number | string;
  status?: string;
  status_detail?: string | { code?: string; description?: string } | null;
  date_created?: string;
  date_closed?: string;
  last_updated?: string;
  date_last_updated?: string;
  pack_id?: number | string | null;
  total_amount?: number;
  paid_amount?: number;
  currency_id?: string;
  coupon?: { id?: string | null; amount?: number } | null;
  seller?: { id?: number | string };
  buyer?: { id?: number | string; nickname?: string; first_name?: string; last_name?: string };
  order_items?: MeliOrderItem[];
  payments?: MeliPayment[];
  shipping?: { id?: number | string | null } | null;
  tags?: string[];
}

interface MeliShipment {
  id?: number | string;
  order_id?: number | string;
  external_reference?: string;
  status?: string;
  substatus?: string | null;
  mode?: string;
  logistic_type?: string;
  logistic?: { mode?: string; type?: string };
  tracking_method?: string;
  date_created?: string;
  last_updated?: string;
  shipping_option?: { cost?: number; list_cost?: number };
  lead_time?: { cost?: number; list_cost?: number };
}

const money = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
};
const date = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const str = (v: unknown, max = 200): string | null => (v === null || v === undefined || v === "" ? null : String(v).slice(0, max));

/** Status agregado do pagamento: aprovado se qualquer pagamento foi aprovado; senão o do mais recente. */
export function paymentStatusOf(payments: MeliPayment[]): string | null {
  if (!payments.length) return null;
  if (payments.some((p) => p.status === "approved")) return "approved";
  const latest = [...payments].sort((a, b) => (date(b.date_last_modified ?? b.date_created)?.getTime() ?? 0) - (date(a.date_last_modified ?? a.date_created)?.getTime() ?? 0))[0];
  return latest.status ?? null;
}

interface MappedItem extends Resolved {
  lineKey: string;
  itemId: string;
  variationId: string | null;
  userProductId: string | null;
  sellerSku: string | null;
  title: string | null;
  categoryId: string | null;
  quantity: string;
  unitPrice: string | null;
  fullUnitPrice: string | null;
  saleFee: string | null;
  currencyId: string | null;
}

async function mapItem(sql: Sql, oi: MeliOrderItem): Promise<MappedItem> {
  const itemId = str(oi.item?.id, 30) ?? "";
  const variationId = str(oi.item?.variation_id, 30);
  const userProductId = str(oi.item?.user_product_id, 40);
  const sellerSku = str(oi.item?.seller_sku, 120);
  const resolved = await resolveProduct(sql, { itemId: itemId || null, variationId, userProductId, sellerSku });
  return {
    lineKey: `${itemId}:${variationId ?? ""}`,
    itemId,
    variationId,
    userProductId,
    sellerSku,
    title: str(oi.item?.title, 300),
    categoryId: str(oi.item?.category_id, 30),
    quantity: String(Number(oi.quantity ?? 0)),
    unitPrice: money(oi.unit_price),
    fullUnitPrice: money(oi.full_unit_price),
    saleFee: money(oi.sale_fee),
    currencyId: str(oi.currency_id, 5),
    ...resolved,
  };
}

export interface OrderProcessResult extends Record<string, unknown> {
  orderId: string;
  packId: string | null;
  orderStatus: string | null;
  paymentStatus: string | null;
  mappingStatus: string;
  adsImportStatus: string;
  stale: boolean;
  shipmentId: string | null;
}

async function fetchShipment(shipmentId: string): Promise<MeliShipment | null> {
  try {
    const { data } = await withReadRetry(() => meliRequest<MeliShipment>(`/shipments/${shipmentId}`, { auth: true, headers: { "x-format-new": "true" } }));
    return data;
  } catch (err) {
    if (err instanceof MeliHttpError && (err.kind === "not_found" || err.kind === "forbidden")) return null;
    throw err;
  }
}

/** Grava o envio (somente leitura); devolve o id do pedido associado, quando informado. */
async function upsertShipment(sql: Sql, s: MeliShipment, orderIdHint: string | null): Promise<void> {
  const shipmentId = str(s.id, 30);
  if (!shipmentId) return;
  const orderId = str(s.order_id, 30) ?? (s.external_reference && /^\d{1,20}$/.test(s.external_reference) ? s.external_reference : null) ?? orderIdHint;
  const lastUpdated = date(s.last_updated);
  await sql.execute(
    `INSERT INTO marketplace_shipments (shipment_id, marketplace_order_id, status, substatus, logistic_type, mode, tracking_method, date_created, ml_last_updated, fetched_at)
     VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::timestamptz, now())
     ON CONFLICT (shipment_id) DO UPDATE SET
       marketplace_order_id = COALESCE(EXCLUDED.marketplace_order_id, marketplace_shipments.marketplace_order_id),
       status = EXCLUDED.status, substatus = EXCLUDED.substatus, logistic_type = EXCLUDED.logistic_type, mode = EXCLUDED.mode,
       tracking_method = EXCLUDED.tracking_method, date_created = COALESCE(EXCLUDED.date_created, marketplace_shipments.date_created),
       ml_last_updated = EXCLUDED.ml_last_updated, fetched_at = now()
     WHERE marketplace_shipments.ml_last_updated IS NULL OR EXCLUDED.ml_last_updated IS NULL OR marketplace_shipments.ml_last_updated <= EXCLUDED.ml_last_updated`,
    [shipmentId, orderId, str(s.status, 40), str(s.substatus, 60), str(s.logistic?.type ?? s.logistic_type, 40), str(s.logistic?.mode ?? s.mode, 20), str(s.tracking_method, 60), date(s.date_created), lastUpdated],
  );
}

async function sellerId(): Promise<string> {
  const conn = await getStore().getCurrentConnection();
  if (!conn?.meliUserId) throw new PermanentEventError("not_connected", "Conta Mercado Livre não conectada");
  return conn.meliUserId;
}

/**
 * Consulta o pedido na API (GET /orders/{id}), o envio (GET /shipments/{id}) e grava tudo de forma
 * idempotente. Leituras mais antigas que a gravada (date_last_updated) não sobrescrevem dados novos.
 */
export async function processOrder(sql: Sql, orderId: string): Promise<OrderProcessResult | null> {
  if (!/^\d{1,20}$/.test(orderId)) throw new PermanentEventError("invalid_order_id", "ID de pedido inválido");
  const seller = await sellerId();
  let order: MeliOrder;
  try {
    order = (await withReadRetry(() => meliRequest<MeliOrder>(`/orders/${orderId}`, { auth: true }))).data;
  } catch (err) {
    if (err instanceof MeliHttpError && err.kind === "not_found") return null;
    throw err;
  }
  if (String(order.seller?.id ?? "") !== seller) throw new PermanentEventError("other_seller", "Pedido não pertence à conta conectada");

  const items = await Promise.all((order.order_items ?? []).slice(0, 200).map((oi) => mapItem(sql, oi)));
  const unmapped = items.filter((i) => i.mappingStatus === "UNMAPPED").length;
  const mapping = mappingStatusOf(items.length, unmapped);
  const payments = (order.payments ?? []).slice(0, 50);
  const paymentStatus = paymentStatusOf(payments);
  const orderStatus = str(order.status, 40);
  const ads = adsStatusOf({ orderStatus, paymentStatus, mapping, unmapped });
  const shipmentId = str(order.shipping?.id, 30);
  const shipment = shipmentId ? await fetchShipment(shipmentId) : null;
  const statusDetail = typeof order.status_detail === "string" ? order.status_detail : (order.status_detail?.code ?? order.status_detail?.description ?? null);
  const productsAmount = items.reduce((acc, i) => acc + Number(i.unitPrice ?? 0) * Number(i.quantity), 0);
  const shippingAmount =
    payments.reduce((acc, p) => acc + Number(p.shipping_cost ?? 0), 0) || Number(shipment?.shipping_option?.cost ?? shipment?.lead_time?.cost ?? 0);
  const discount = Number(order.coupon?.amount ?? 0) || payments.reduce((acc, p) => acc + Number(p.coupon_amount ?? 0), 0);
  const lastUpdated = date(order.date_last_updated ?? order.last_updated);
  const retention = getMarketplaceConfig().orderRawRetentionDays;

  return sql.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO marketplace_order_inbox (marketplace_order_id, pack_id, seller_id, buyer_id, buyer_nickname, buyer_first_name, buyer_last_name,
         order_status, order_status_detail, payment_status, currency_id, products_amount, discount_amount, shipping_amount, total_amount, paid_amount,
         shipment_id, tags, date_created, date_closed, ml_last_updated, mapping_status, ads_import_status, ads_status_reason, last_error,
         last_fetched_at, updated_at)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::text, $12::numeric,
         $13::numeric, $14::numeric, $15::numeric, $16::numeric, $17::text, $18::jsonb, $19::timestamptz, $20::timestamptz, $21::timestamptz,
         $22::text, $23::text, $24::text, NULL, now(), now())
       ON CONFLICT (marketplace_order_id) DO UPDATE SET
         pack_id = EXCLUDED.pack_id, buyer_id = EXCLUDED.buyer_id, buyer_nickname = EXCLUDED.buyer_nickname,
         buyer_first_name = EXCLUDED.buyer_first_name, buyer_last_name = EXCLUDED.buyer_last_name, order_status = EXCLUDED.order_status,
         order_status_detail = EXCLUDED.order_status_detail, payment_status = EXCLUDED.payment_status, currency_id = EXCLUDED.currency_id,
         products_amount = EXCLUDED.products_amount, discount_amount = EXCLUDED.discount_amount, shipping_amount = EXCLUDED.shipping_amount,
         total_amount = EXCLUDED.total_amount, paid_amount = EXCLUDED.paid_amount, shipment_id = EXCLUDED.shipment_id, tags = EXCLUDED.tags,
         date_created = EXCLUDED.date_created, date_closed = EXCLUDED.date_closed, ml_last_updated = EXCLUDED.ml_last_updated,
         mapping_status = EXCLUDED.mapping_status, ads_import_status = EXCLUDED.ads_import_status, ads_status_reason = EXCLUDED.ads_status_reason,
         last_error = NULL, last_fetched_at = now(), updated_at = now()
       WHERE marketplace_order_inbox.ml_last_updated IS NULL OR EXCLUDED.ml_last_updated IS NULL
          OR marketplace_order_inbox.ml_last_updated <= EXCLUDED.ml_last_updated
       RETURNING id::text AS id`,
      [
        orderId,
        str(order.pack_id, 30),
        seller,
        str(order.buyer?.id, 30),
        str(order.buyer?.nickname, 120),
        str(order.buyer?.first_name, 120),
        str(order.buyer?.last_name, 120),
        orderStatus,
        str(statusDetail, 200),
        paymentStatus,
        str(order.currency_id, 5),
        productsAmount.toFixed(2),
        discount.toFixed(2),
        shippingAmount.toFixed(2),
        money(order.total_amount),
        money(order.paid_amount),
        shipmentId,
        JSON.stringify((order.tags ?? []).slice(0, 30)),
        date(order.date_created),
        date(order.date_closed),
        lastUpdated,
        mapping,
        ads.status,
        ads.reason,
      ],
    );
    const base: OrderProcessResult = { orderId, packId: str(order.pack_id, 30), orderStatus, paymentStatus, mappingStatus: mapping, adsImportStatus: ads.status, stale: false, shipmentId };
    if (!rows.length) {
      // Leitura fora de ordem: mantém o registro mais recente.
      const [cur] = await tx.query<{ orderStatus: string; adsImportStatus: string; mappingStatus: string; paymentStatus: string | null }>(
        `SELECT order_status AS "orderStatus", ads_import_status AS "adsImportStatus", mapping_status AS "mappingStatus", payment_status AS "paymentStatus"
         FROM marketplace_order_inbox WHERE marketplace_order_id = $1::text`,
        [orderId],
      );
      return { ...base, ...cur, stale: true };
    }
    const id = rows[0].id;
    for (const it of items) {
      await tx.execute(
        `INSERT INTO marketplace_order_items (order_id, line_key, marketplace_item_id, variation_id, user_product_id, seller_sku, title, category_id,
           quantity, unit_price, full_unit_price, sale_fee, currency_id, listing_id, product_id, ads_product_id, mapping_status, mapping_method, mapping_id)
         VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::numeric, $10::numeric, $11::numeric,
           $12::numeric, $13::text, $14::int, $15::int, $16::int, $17::text, $18::text, $19::bigint)
         ON CONFLICT (order_id, line_key) DO UPDATE SET user_product_id = EXCLUDED.user_product_id, seller_sku = EXCLUDED.seller_sku,
           title = EXCLUDED.title, category_id = EXCLUDED.category_id, quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price,
           full_unit_price = EXCLUDED.full_unit_price, sale_fee = EXCLUDED.sale_fee, currency_id = EXCLUDED.currency_id,
           listing_id = EXCLUDED.listing_id, product_id = EXCLUDED.product_id, ads_product_id = EXCLUDED.ads_product_id,
           mapping_status = EXCLUDED.mapping_status, mapping_method = EXCLUDED.mapping_method, mapping_id = EXCLUDED.mapping_id
         WHERE marketplace_order_items.mapping_method IS DISTINCT FROM 'MANUAL'`,
        [id, it.lineKey, it.itemId, it.variationId, it.userProductId, it.sellerSku, it.title, it.categoryId, it.quantity, it.unitPrice, it.fullUnitPrice, it.saleFee, it.currencyId, it.listingId, it.productId, it.adsProductId, it.mappingStatus, it.mappingMethod, it.mappingId],
      );
    }
    await tx.execute(`DELETE FROM marketplace_order_items WHERE order_id = $1::bigint AND NOT (line_key = ANY($2::text[]))`, [id, items.map((i) => i.lineKey)]);
    for (const p of payments) {
      const pid = str(p.id, 30);
      if (!pid) continue;
      await tx.execute(
        `INSERT INTO marketplace_order_payments (order_id, payment_id, status, status_detail, payment_type, payment_method_id, installments,
           transaction_amount, total_paid_amount, shipping_cost, coupon_amount, date_created, date_approved, date_last_modified)
         VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::text, $7::int, $8::numeric, $9::numeric, $10::numeric, $11::numeric,
           $12::timestamptz, $13::timestamptz, $14::timestamptz)
         ON CONFLICT (order_id, payment_id) DO UPDATE SET status = EXCLUDED.status, status_detail = EXCLUDED.status_detail,
           payment_type = EXCLUDED.payment_type, payment_method_id = EXCLUDED.payment_method_id, installments = EXCLUDED.installments,
           transaction_amount = EXCLUDED.transaction_amount, total_paid_amount = EXCLUDED.total_paid_amount, shipping_cost = EXCLUDED.shipping_cost,
           coupon_amount = EXCLUDED.coupon_amount, date_approved = EXCLUDED.date_approved, date_last_modified = EXCLUDED.date_last_modified`,
        [id, pid, str(p.status, 40), str(p.status_detail, 80), str(p.payment_type, 40), str(p.payment_method_id, 40), p.installments ?? null, money(p.transaction_amount), money(p.total_paid_amount), money(p.shipping_cost), money(p.coupon_amount), date(p.date_created), date(p.date_approved), date(p.date_last_modified)],
      );
    }
    if (shipment) await upsertShipment(tx, shipment, orderId);
    await tx.execute(
      `INSERT INTO marketplace_order_raw (order_id, payload, fetched_at, expires_at) VALUES ($1::bigint, $2::jsonb, now(), now() + make_interval(days => $3::int))
       ON CONFLICT (order_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now(), expires_at = EXCLUDED.expires_at`,
      [id, JSON.stringify(order), retention],
    );
    return base;
  });
}

/** Envio: grava a situação e relaciona ao pedido; pedido ainda desconhecido é enfileirado para consulta. */
export async function processShipment(sql: Sql, shipmentId: string): Promise<Record<string, unknown> | null> {
  if (!/^\d{1,20}$/.test(shipmentId)) throw new PermanentEventError("invalid_shipment_id", "ID de envio inválido");
  const seller = await sellerId();
  const s = await fetchShipment(shipmentId);
  if (!s) return null;
  const [linked] = await sql.query<{ orderId: string }>(`SELECT marketplace_order_id AS "orderId" FROM marketplace_order_inbox WHERE shipment_id = $1::text LIMIT 1`, [shipmentId]);
  await upsertShipment(sql, s, linked?.orderId ?? null);
  const orderId = str(s.order_id, 30) ?? linked?.orderId ?? null;
  let enqueued = false;
  let orderFetched = false;
  if (orderId && !linked) {
    const [known] = await sql.query<{ id: string }>(`SELECT id::text AS id FROM marketplace_order_inbox WHERE marketplace_order_id = $1::text`, [orderId]);
    if (known) await sql.execute(`UPDATE marketplace_order_inbox SET shipment_id = $2::text, updated_at = now() WHERE id = $1::bigint AND shipment_id IS NULL`, [known.id, shipmentId]);
    else {
      // Pedido ainda desconhecido: consulta agora; se falhar, fica na fila como evento interno (com retentativas).
      try {
        orderFetched = (await processOrder(sql, orderId)) !== null;
      } catch {
        enqueued = await enqueueDerived(sql, { topic: "orders_v2", resource: `/orders/${orderId}`, sellerId: seller, key: `shipment:${shipmentId}:order:${orderId}` });
      }
    }
  }
  return { shipmentId, orderId, status: str(s.status, 40), substatus: str(s.substatus, 60), orderFetched, orderEnqueued: enqueued };
}

/**
 * Rede de segurança dos webhooks: pedidos atualizados nas últimas horas (GET /orders/search) que não
 * estão no banco, ou estão com versão anterior, são enfileirados como eventos internos.
 */
export async function recoverRecentOrders(sql: Sql, opts: { deadline?: number } = {}): Promise<{ checked: number; enqueued: number; complete: boolean }> {
  const seller = await sellerId();
  const hours = getMarketplaceConfig().ordersRecoveryWindowHours;
  const from = new Date(Date.now() - hours * 3_600_000).toISOString();
  let checked = 0;
  let enqueued = 0;
  let complete = true;
  for (let offset = 0, page = 0; page < 20; page++, offset += 50) {
    if (opts.deadline !== undefined && opts.deadline - Date.now() < 4_000) {
      complete = false;
      break;
    }
    const { data } = await withReadRetry(() =>
      meliRequest<{ results?: MeliOrder[]; paging?: { total?: number } }>("/orders/search", {
        auth: true,
        query: { seller, "order.date_last_updated.from": from, sort: "date_desc", offset, limit: 50 },
      }),
    );
    const results = (data?.results ?? []).filter((o) => /^\d{1,20}$/.test(String(o.id ?? "")));
    for (const o of results) {
      checked++;
      const id = String(o.id);
      const lu = date(o.date_last_updated ?? o.last_updated);
      const [cur] = await sql.query<{ lu: Date | null }>(`SELECT ml_last_updated AS lu FROM marketplace_order_inbox WHERE marketplace_order_id = $1::text`, [id]);
      if (cur && cur.lu && lu && new Date(cur.lu).getTime() >= lu.getTime()) continue;
      if (await enqueueDerived(sql, { topic: "orders_v2", resource: `/orders/${id}`, sellerId: seller, key: `recovery:${id}:${lu?.toISOString() ?? "na"}` })) enqueued++;
    }
    const total = data?.paging?.total ?? 0;
    if (results.length < 50 || offset + 50 >= total) break;
  }
  return { checked, enqueued, complete };
}

// ---------------------------------------------------------------------------
// Consultas para o painel /pedidos (somente dados mínimos; JSON original só em endpoint próprio).
// ---------------------------------------------------------------------------
export interface OrderListItem {
  id: string;
  marketplaceOrderId: string;
  packId: string | null;
  dateCreated: Date | null;
  buyerNickname: string | null;
  buyerName: string | null;
  itemCount: number;
  unitCount: string;
  totalAmount: string | null;
  currencyId: string | null;
  paymentStatus: string | null;
  orderStatus: string | null;
  mappingStatus: string;
  adsImportStatus: string;
  adsStatusReason: string | null;
  updatedAt: Date;
}

/** Ambiente ADS atual (homologação/produção); null quando a ADS não está configurada. */
function currentAdsEnvironment(): string | null {
  try {
    return adsEnvironment().environment;
  } catch {
    return null;
  }
}

/**
 * Envio vigente que cobre o pedido `o` no ambiente $envParam: o do próprio pedido ou o do pack
 * inteiro (idExterno "P…", gravado no pedido principal). O envio avulso de OUTRO pedido do pack não conta.
 */
const submissionJoin = (envParam: string) => `LEFT JOIN LATERAL (
    SELECT s.status, s.ads_pedido_id, s.ads_status FROM ads_order_submissions s
    WHERE s.environment = ${envParam}::text AND s.status IN ('SENDING', 'SENT', 'UNKNOWN')
      AND (s.order_id = o.id OR (o.pack_id IS NOT NULL AND s.external_id LIKE 'P%'
           AND s.order_id IN (SELECT p.id FROM marketplace_order_inbox p WHERE p.pack_id = o.pack_id)))
    ORDER BY s.created_at LIMIT 1) sub ON true`;
const EFFECTIVE_STATUS = `CASE WHEN sub.status = 'SENT' THEN 'ADS_SENT' WHEN sub.status IS NOT NULL THEN 'ADS_SENDING' ELSE o.ads_import_status END`;
const EFFECTIVE_REASON = `CASE WHEN sub.status = 'SENT' THEN concat('Pedido ADS ', sub.ads_pedido_id, ' · ' || sub.ads_status)
  WHEN sub.status = 'UNKNOWN' THEN 'Resultado do envio incerto: consulte o resultado na ADS'
  WHEN sub.status IS NOT NULL THEN 'Envio em andamento' ELSE o.ads_status_reason END`;

export async function listOrders(sql: Sql, opts: { adsStatus?: string; mapping?: string; q?: string; page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const where: string[] = [];
  const params: unknown[] = [currentAdsEnvironment()];
  const join = submissionJoin("$1");
  if (opts.adsStatus) {
    params.push(opts.adsStatus);
    where.push(`${EFFECTIVE_STATUS} = $${params.length}::text`);
  }
  if (opts.mapping) {
    params.push(opts.mapping);
    where.push(`o.mapping_status = $${params.length}::text`);
  }
  if (opts.q?.trim()) {
    params.push(opts.q.trim());
    where.push(`(o.marketplace_order_id = $${params.length}::text OR o.pack_id = $${params.length}::text OR o.buyer_nickname ILIKE '%' || $${params.length}::text || '%')`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ total }] = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM marketplace_order_inbox o ${join} ${clause}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const items = await sql.query<OrderListItem>(
    `SELECT o.id::text AS id, o.marketplace_order_id AS "marketplaceOrderId", o.pack_id AS "packId", o.date_created AS "dateCreated",
            o.buyer_nickname AS "buyerNickname", NULLIF(trim(concat_ws(' ', o.buyer_first_name, o.buyer_last_name)), '') AS "buyerName",
            (SELECT count(*)::int FROM marketplace_order_items i WHERE i.order_id = o.id) AS "itemCount",
            (SELECT COALESCE(sum(quantity), 0)::text FROM marketplace_order_items i WHERE i.order_id = o.id) AS "unitCount",
            o.total_amount::text AS "totalAmount", o.currency_id AS "currencyId", o.payment_status AS "paymentStatus", o.order_status AS "orderStatus",
            o.mapping_status AS "mappingStatus", ${EFFECTIVE_STATUS} AS "adsImportStatus", ${EFFECTIVE_REASON} AS "adsStatusReason", o.updated_at AS "updatedAt"
     FROM marketplace_order_inbox o ${join} ${clause}
     ORDER BY o.date_created DESC NULLS LAST, o.id DESC LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
    params,
  );
  const counts = await sql.query<{ status: string; n: number }>(
    `SELECT ${EFFECTIVE_STATUS} AS status, count(*)::int AS n FROM marketplace_order_inbox o ${join} GROUP BY 1`,
    [params[0]],
  );
  return { items, total, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number> };
}

export async function getOrder(sql: Sql, id: string) {
  if (!/^\d{1,19}$/.test(id)) return null;
  const [order] = await sql.query<Record<string, unknown>>(
    `SELECT o.id::text AS id, o.marketplace_order_id AS "marketplaceOrderId", o.pack_id AS "packId", o.seller_id AS "sellerId",
            o.buyer_id AS "buyerId", o.buyer_nickname AS "buyerNickname", NULLIF(trim(concat_ws(' ', o.buyer_first_name, o.buyer_last_name)), '') AS "buyerName",
            o.order_status AS "orderStatus", o.order_status_detail AS "orderStatusDetail", o.payment_status AS "paymentStatus", o.currency_id AS "currencyId",
            o.products_amount::text AS "productsAmount", o.discount_amount::text AS "discountAmount", o.shipping_amount::text AS "shippingAmount",
            o.total_amount::text AS "totalAmount", o.paid_amount::text AS "paidAmount", o.shipment_id AS "shipmentId", o.tags,
            o.date_created AS "dateCreated", o.date_closed AS "dateClosed", o.ml_last_updated AS "mlLastUpdated", o.mapping_status AS "mappingStatus",
            ${EFFECTIVE_STATUS} AS "adsImportStatus", ${EFFECTIVE_REASON} AS "adsStatusReason", o.last_error AS "lastError",
            o.received_at AS "receivedAt", o.last_fetched_at AS "lastFetchedAt", o.updated_at AS "updatedAt",
            EXISTS (SELECT 1 FROM marketplace_order_raw r WHERE r.order_id = o.id) AS "hasRaw"
     FROM marketplace_order_inbox o ${submissionJoin("$2")} WHERE o.id = $1::bigint`,
    [id, currentAdsEnvironment()],
  );
  if (!order) return null;
  const [items, payments, shipments, packOrders] = await Promise.all([
    sql.query(
      `SELECT i.marketplace_item_id AS "itemId", i.variation_id AS "variationId", i.user_product_id AS "userProductId", i.seller_sku AS "sellerSku",
              i.title, i.quantity::text AS quantity, i.unit_price::text AS "unitPrice", i.full_unit_price::text AS "fullUnitPrice", i.sale_fee::text AS "saleFee",
              i.listing_id AS "listingId", i.product_id AS "productId", i.ads_product_id AS "adsProductId", i.mapping_status AS "mappingStatus",
              i.mapping_method AS "mappingMethod", COALESCE(p.name_custom, p.name_original) AS "productName"
       FROM marketplace_order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = $1::bigint ORDER BY i.id`,
      [id],
    ),
    sql.query(
      `SELECT payment_id AS "paymentId", status, status_detail AS "statusDetail", payment_type AS "paymentType", payment_method_id AS "paymentMethodId",
              installments, transaction_amount::text AS "transactionAmount", total_paid_amount::text AS "totalPaidAmount", shipping_cost::text AS "shippingCost",
              coupon_amount::text AS "couponAmount", date_approved AS "dateApproved"
       FROM marketplace_order_payments WHERE order_id = $1::bigint ORDER BY id`,
      [id],
    ),
    sql.query(
      `SELECT shipment_id AS "shipmentId", status, substatus, logistic_type AS "logisticType", mode, tracking_method AS "trackingMethod",
              ml_last_updated AS "mlLastUpdated", fetched_at AS "fetchedAt"
       FROM marketplace_shipments WHERE shipment_id = $1::text OR marketplace_order_id = $2::text`,
      [order.shipmentId ?? "", order.marketplaceOrderId],
    ),
    order.packId
      ? sql.query(`SELECT id::text AS id, marketplace_order_id AS "marketplaceOrderId" FROM marketplace_order_inbox WHERE pack_id = $1::text AND id <> $2::bigint ORDER BY id`, [order.packId, id])
      : Promise.resolve([]),
  ]);
  return { order, items, payments, shipments, packOrders };
}

/** JSON original (acesso restrito: só pelo endpoint administrativo dedicado). */
export async function getOrderRaw(sql: Sql, id: string): Promise<unknown | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  const [row] = await sql.query<{ payload: unknown }>(`SELECT payload FROM marketplace_order_raw WHERE order_id = $1::bigint AND expires_at > now()`, [id]);
  return row?.payload ?? null;
}
