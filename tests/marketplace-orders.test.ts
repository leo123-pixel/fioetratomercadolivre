import { describe, expect, it } from "vitest";
import { GET as ordersGet } from "@/app/api/orders/route";
import { GET as orderGet } from "@/app/api/orders/[id]/route";
import { GET as orderRawGet } from "@/app/api/orders/[id]/raw/route";
import { POST as orderRefresh } from "@/app/api/orders/[id]/refresh/route";
import { ingestNotification, processEvents } from "@/lib/marketplace/events";
import { adsStatusOf, paymentStatusOf, processOrder, recoverRecentOrders } from "@/lib/marketplace/orders";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { mockMeliEvents, notification, order, SELLER, shipment } from "./helpers/meli-events-mock";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";

const t = useTestDatabase();
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

async function setup() {
  await seedConnection({ expiresInMs: 3_600_000 });
  return mockMeliEvents();
}

async function seedPublished(itemId: string, ads: number, userProductId: string | null = null) {
  const sql = t.sql();
  const [{ id: productId }] = await sql.query<{ id: number }>(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, '{}') RETURNING id`, [ads, `PRODUTO ${ads}`]);
  const [{ id: draftId }] = await sql.query<{ id: number }>(`INSERT INTO listing_drafts (product_id, status) VALUES ($1, 'PUBLISHED') RETURNING id`, [productId]);
  await sql.execute(
    `INSERT INTO marketplace_listings (product_id, ads_product_id, listing_draft_id, marketplace_account_id, marketplace_item_id, category_id, price, quantity, status, user_product_id)
     VALUES ($1, $2, $3, $4, $5, 'MLB264861', 99.9, 3, 'active', $6)`,
    [productId, ads, draftId, SELLER, itemId, userProductId],
  );
  return productId;
}

const inbox = async () =>
  t.sql().query<Record<string, unknown>>(
    `SELECT id::text AS id, marketplace_order_id AS "orderId", pack_id AS "packId", order_status AS "orderStatus", payment_status AS "paymentStatus",
            mapping_status AS "mapping", ads_import_status AS "ads", ads_status_reason AS "reason", total_amount::text AS total,
            products_amount::text AS products, shipping_amount::text AS shipping, discount_amount::text AS discount, shipment_id AS "shipmentId",
            buyer_nickname AS "buyerNickname", ml_last_updated AS "lu"
     FROM marketplace_order_inbox ORDER BY id`,
  );
const items = async () =>
  t.sql().query<Record<string, unknown>>(
    `SELECT marketplace_item_id AS "itemId", quantity::text AS quantity, unit_price::text AS "unitPrice", ads_product_id AS "adsProductId",
            mapping_status AS mapping, mapping_method AS method FROM marketplace_order_items ORDER BY id`,
  );

describe("pedidos (orders_v2): recepção, consulta e armazenamento — nada é enviado à ADS", () => {
  it("recebe orders_v2, consulta pedido/pagamento/envio, vincula ao produto ADS pelo anúncio e fica READY_FOR_ADS", async () => {
    const { state, handler } = await setup();
    await seedPublished("MLB1000", 1804);
    state.orders.set("2000001", order("2000001"));
    state.shipments.set("4440001", shipment("4440001", "2000001"));
    await ingestNotification(t.sql(), notification("orders_v2", "/orders/2000001"));
    await processEvents({ sql: t.sql() });
    expect(await inbox()).toMatchObject([
      { orderId: "2000001", orderStatus: "paid", paymentStatus: "approved", mapping: "MAPPED", ads: "READY_FOR_ADS", total: "99.90", products: "99.90", shipping: "19.90", discount: "0.00", shipmentId: "4440001", buyerNickname: "COMPRADOR.TESTE" },
    ]);
    expect(await items()).toEqual([{ itemId: "MLB1000", quantity: "1.000", unitPrice: "99.90", adsProductId: 1804, mapping: "MAPPED", method: "LISTING" }]);
    expect(await t.sql().query(`SELECT payment_id AS id, status, shipping_cost::text AS ship FROM marketplace_order_payments`)).toEqual([{ id: "5550001", status: "approved", ship: "19.90" }]);
    expect(await t.sql().query(`SELECT shipment_id AS id, marketplace_order_id AS "orderId", status, logistic_type AS lt FROM marketplace_shipments`)).toEqual([
      { id: "4440001", orderId: "2000001", status: "ready_to_ship", lt: "drop_off" },
    ]);
    // Só leituras no ML; nenhuma chamada a outro host (ADS).
    expect(handler.mock.calls.every(([u, init]) => String(u).startsWith("https://api.mercadolibre.com") && (init?.method ?? "GET") === "GET")).toBe(true);
    expect(state.calls.find((c) => c.path === "/shipments/4440001")).toBeTruthy();
  });

  it("produto não identificado fica UNMAPPED e o pedido aguarda mapeamento manual (sem vínculo por título)", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804);
    state.orders.set(
      "2000002",
      order("2000002", {
        order_items: [
          { item: { id: "MLB1000", title: "Oxidante", seller_sku: "ADS-1804" }, quantity: 2, unit_price: 50, currency_id: "BRL" },
          { item: { id: "MLB7777", title: "PRODUTO 1804", seller_sku: null }, quantity: 1, unit_price: 10, currency_id: "BRL" },
        ],
        shipping: null,
      }),
    );
    const r = await processOrder(t.sql(), "2000002");
    expect(r).toMatchObject({ mappingStatus: "PARTIAL", adsImportStatus: "READY_FOR_MAPPING" });
    expect(await items()).toMatchObject([
      { itemId: "MLB1000", mapping: "MAPPED", method: "LISTING" },
      { itemId: "MLB7777", mapping: "UNMAPPED", method: null, adsProductId: null },
    ]);
    expect((await inbox())[0]).toMatchObject({ products: "110.00", reason: "1 item(ns) sem produto ADS correspondente" });
  });

  it("vínculo por User Product e por SELLER_SKU ADS-<id> quando o anúncio não é do integrador", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804, "MLBU55");
    await t.sql().execute(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES (9232, 'OUTRO', '{}')`);
    state.orders.set(
      "2000003",
      order("2000003", {
        order_items: [
          { item: { id: "MLB2222", user_product_id: "MLBU55", seller_sku: null }, quantity: 1, unit_price: 10 },
          { item: { id: "MLB3333", seller_sku: "ADS-9232" }, quantity: 1, unit_price: 20 },
        ],
        shipping: null,
      }),
    );
    await processOrder(t.sql(), "2000003");
    expect(await items()).toMatchObject([
      { itemId: "MLB2222", mapping: "MAPPED", method: "USER_PRODUCT", adsProductId: 1804 },
      { itemId: "MLB3333", mapping: "MAPPED", method: "SELLER_SKU", adsProductId: 9232 },
    ]);
  });

  it("pedidos com pack: order_id e pack_id distintos; vários pedidos do mesmo pack", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804);
    state.orders.set("2000010", order("2000010", { pack_id: 2000000099, shipping: null }));
    state.orders.set("2000011", order("2000011", { pack_id: 2000000099, shipping: null }));
    await processOrder(t.sql(), "2000010");
    await processOrder(t.sql(), "2000011");
    expect((await inbox()).map((o) => [o.orderId, o.packId])).toEqual([
      ["2000010", "2000000099"],
      ["2000011", "2000000099"],
    ]);
    const [{ id }] = await inbox();
    const res = await orderGet(makeRequest(`/api/orders/${id}`, { cookies: adminCookies() }), ctx({ id: String(id) }));
    expect((await res.json()).packOrders).toEqual([{ id: expect.any(String), marketplaceOrderId: "2000011" }]);
  });

  it("pedido cancelado fica BLOCKED; atualização de status (pendente → pago) é refletida", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804);
    state.orders.set("2000020", order("2000020", { status: "payment_required", payments: [{ id: 1, status: "pending", date_created: "2026-11-05T12:00:00Z" }], shipping: null, date_last_updated: "2026-11-05T12:00:00Z" }));
    await processOrder(t.sql(), "2000020");
    expect((await inbox())[0]).toMatchObject({ ads: "RECEIVED", paymentStatus: "pending" });
    state.orders.set("2000020", order("2000020", { status: "paid", shipping: null, date_last_updated: "2026-11-05T13:00:00Z" }));
    await processOrder(t.sql(), "2000020");
    expect((await inbox())[0]).toMatchObject({ ads: "READY_FOR_ADS", orderStatus: "paid", paymentStatus: "approved" });
    state.orders.set("2000020", order("2000020", { status: "cancelled", shipping: null, date_last_updated: "2026-11-05T14:00:00Z" }));
    await processOrder(t.sql(), "2000020");
    expect((await inbox())[0]).toMatchObject({ ads: "BLOCKED", orderStatus: "cancelled", reason: "Pedido cancelado no Mercado Livre" });
  });

  it("deduplicação: o mesmo pedido notificado várias vezes gera um único registro; leitura antiga não sobrescreve a nova", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804);
    state.orders.set("2000030", order("2000030", { status: "paid", shipping: null, date_last_updated: "2026-11-05T15:00:00Z" }));
    for (let i = 0; i < 3; i++) await ingestNotification(t.sql(), notification("orders_v2", "/orders/2000030"));
    await processEvents({ sql: t.sql() });
    expect(await inbox()).toHaveLength(1);
    expect(await items()).toHaveLength(1);
    state.orders.set("2000030", order("2000030", { status: "payment_required", shipping: null, date_last_updated: "2026-11-05T14:00:00Z" }));
    const r = await processOrder(t.sql(), "2000030");
    expect(r).toMatchObject({ stale: true, orderStatus: "paid" });
    expect((await inbox())[0]).toMatchObject({ orderStatus: "paid" });
  });

  it("notificação de envio de pedido ainda desconhecido consulta o pedido e relaciona o envio", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804);
    state.shipments.set("4440009", shipment("4440009", "2000040"));
    state.orders.set("2000040", order("2000040", { shipping: { id: 4440009 } }));
    await ingestNotification(t.sql(), notification("shipments", "/shipments/4440009"));
    await processEvents({ sql: t.sql() });
    const evs = await t.sql().query<{ topic: string; source: string; status: string }>(`SELECT topic, source, status FROM marketplace_webhook_events ORDER BY id`);
    expect(evs).toEqual([{ topic: "shipments", source: "webhook", status: "COMPLETED" }]);
    expect((await inbox())[0]).toMatchObject({ orderId: "2000040", shipmentId: "4440009" });
    // Endereço do destinatário não é guardado na tabela de envios.
    const cols = await t.sql().query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'marketplace_shipments'`);
    expect(cols.map((c) => c.column_name).some((c) => /address|receiver/.test(c))).toBe(false);
  });

  it("pedido de outra conta é ignorado; pedido inexistente é ignorado", async () => {
    const { state } = await setup();
    state.orders.set("2000050", order("2000050", { seller: { id: 999 } }));
    await ingestNotification(t.sql(), notification("orders_v2", "/orders/2000050"));
    await ingestNotification(t.sql(), notification("orders_v2", "/orders/2000051"));
    await processEvents({ sql: t.sql() });
    const evs = await t.sql().query<{ status: string; reason: string }>(`SELECT status, ignored_reason AS reason FROM marketplace_webhook_events ORDER BY id`);
    expect(evs).toEqual([
      { status: "IGNORED", reason: "other_seller" },
      { status: "IGNORED", reason: "not_found" },
    ]);
    expect(await inbox()).toHaveLength(0);
  });

  it("varredura de recuperação enfileira pedidos ausentes ou desatualizados", async () => {
    const { state } = await setup();
    state.orders.set("2000060", order("2000060", { shipping: null }));
    const r = await recoverRecentOrders(t.sql());
    expect(r).toEqual({ checked: 1, enqueued: 1 });
    await processEvents({ sql: t.sql() });
    expect(await inbox()).toHaveLength(1);
    expect(await recoverRecentOrders(t.sql())).toEqual({ checked: 1, enqueued: 0 });
  });

  it("regras de status de preparação e de pagamento", () => {
    expect(paymentStatusOf([])).toBeNull();
    expect(paymentStatusOf([{ status: "rejected" }, { status: "approved" }])).toBe("approved");
    expect(adsStatusOf({ orderStatus: "paid", paymentStatus: "approved", mapping: "UNMAPPED", unmapped: 1 }).status).toBe("READY_FOR_MAPPING");
    expect(adsStatusOf({ orderStatus: "invalid", paymentStatus: null, mapping: "MAPPED", unmapped: 0 }).status).toBe("BLOCKED");
  });
});

describe("pedidos: acesso administrativo e dados pessoais", () => {
  it("listagem e detalhe exigem administrador; listagem não traz o JSON original", async () => {
    const { state } = await setup();
    await seedPublished("MLB1000", 1804);
    state.orders.set("2000070", order("2000070", { shipping: null }));
    await processOrder(t.sql(), "2000070");
    expect((await ordersGet(makeRequest("/api/orders"))).status).toBe(401);
    const res = await ordersGet(makeRequest("/api/orders", { cookies: adminCookies() }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("2000070");
    // Listagem: só os dados mínimos (sem JSON original, pagamentos ou endereço).
    expect(text).not.toMatch(/"raw"|accredited|order_items|receiver/);
  });

  it("JSON original: só administrador, com limite de acesso; expira pela retenção", async () => {
    const { state } = await setup();
    state.orders.set("2000080", order("2000080", { shipping: null }));
    await processOrder(t.sql(), "2000080");
    const [{ id }] = await inbox();
    expect((await orderRawGet(makeRequest(`/api/orders/${id}/raw`), ctx({ id: String(id) }))).status).toBe(401);
    const ok = await orderRawGet(makeRequest(`/api/orders/${id}/raw`, { cookies: adminCookies() }), ctx({ id: String(id) }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).raw.id).toBe(2000080);
    await t.sql().execute(`UPDATE marketplace_order_raw SET expires_at = now() - interval '1 second'`);
    expect((await orderRawGet(makeRequest(`/api/orders/${id}/raw`, { cookies: adminCookies() }), ctx({ id: String(id) }))).status).toBe(404);
  });

  it("releitura manual do pedido exige mesma origem e só lê no ML", async () => {
    const { state } = await setup();
    state.orders.set("2000090", order("2000090", { shipping: null }));
    await processOrder(t.sql(), "2000090");
    const [{ id }] = await inbox();
    expect((await orderRefresh(makeRequest(`/api/orders/${id}/refresh`, { method: "POST", cookies: adminCookies() }), ctx({ id: String(id) }))).status).toBe(403);
    const r = await orderRefresh(makeRequest(`/api/orders/${id}/refresh`, { method: "POST", cookies: adminCookies(), headers: { origin: BASE } }), ctx({ id: String(id) }));
    expect(r.status).toBe(200);
    expect(state.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
