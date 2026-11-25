import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/ads/order-settings/route";
import { GET as nsAdsGet, POST as nsAdsPost } from "@/app/api/nuvemshop/orders/[orderId]/ads/route";
import { GET as nsOrdersGet } from "@/app/api/nuvemshop/orders/route";
import { getAdsOrderSettings, settingsKey, type AdsOrderSettings } from "@/lib/ads/commercial";
import { updateInventorySettings } from "@/lib/inventory/settings";
import { NuvemshopApiError, resetNuvemshopThrottleForTests } from "@/lib/nuvemshop/client";
import { buildNsAdsOrder, nsDiscountTotal, nsShippingCost, parseNsBilling, reconcileNsSubmission, sendNsOrderToAds, ufOf } from "@/lib/nuvemshop/ads-orders";
import { confirmMapping } from "@/lib/nuvemshop/mapping";
import { createImportJob, processNuvemshopJobs } from "@/lib/nuvemshop/import";
import { handleCallback, startAuthorization } from "@/lib/nuvemshop/oauth";
import { confirmAdsReflection, invalidFieldsOf, ORDER_FIELDS, upsertOrder, withFieldFallback } from "@/lib/nuvemshop/orders";
import { handlePrivacyWebhook } from "@/lib/nuvemshop/webhooks";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { FakeNuvemshop, NS_STORE, nsEnv, type FakeOrder } from "./helpers/nuvemshop-mock";
import { useTestDatabase } from "./helpers/pg";

/**
 * Pedidos Nuvemshop → ADS (envio manual). Nuvemshop e ADS SIMULADAS: nenhuma rede real.
 */
const t = useTestDatabase();
const sql = () => t.sql();
const ACTOR = "admin:teste";
const HOM = "https://hom.adsapi.com.br";
const CPF = "52998224725";
const ctx = (orderId: string) => ({ params: Promise.resolve({ orderId }) });
const noSleep = async () => {};

const SETTINGS: AdsOrderSettings = {
  operacaoId: "01",
  canalId: "04",
  formaDePagamentoId: "05",
  prazoId: "001",
  representanteId: null,
  tabela: "F",
  categoriaItem: "N",
  freightMode: "buyer_paid",
  discountMode: "coupon",
  itemPriceMode: "sale_price",
  dueDateBase: "payment_approved",
  customerSetorId: "01",
  customerClasseId: "02",
  customerDefaultPhone: "4133334444",
  customerDefaultEmail: null,
};

interface Ads {
  clientes: { clienteId: number; cnpjCpf: string }[];
  orders: Map<string, number>;
  posts: { path: string; body: Record<string, unknown> }[];
  postMode: ("ok" | "timeout_created" | "400")[];
  next: number;
}
let ns: FakeNuvemshop;
let ads: Ads;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  for (const [k, v] of Object.entries(nsEnv())) process.env[k] = v;
  process.env.ADS_API_BASE_URL = HOM;
  resetNuvemshopThrottleForTests();
  ns = new FakeNuvemshop();
  ns.scope = "read_products,read_locations,read_orders";
  ads = { clientes: [], orders: new Map(), posts: [], postMode: [], next: 7001 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname.includes("tiendanube") || url.hostname.includes("nuvemshop")) return ns.fetch(url.href, init);
      if (url.origin !== HOM) throw new Error(`fetch inesperado: ${url}`);
      const path = url.pathname.replace(/^\/api\/v1\/\d+\//, "");
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "null"));
        ads.posts.push({ path, body });
        if (path === "clientes") {
          const id = 800 + ads.clientes.length;
          ads.clientes.push({ clienteId: id, cnpjCpf: body.cnpjCpf });
          return json({ clienteId: id }, 201);
        }
        if (path === "pedidos") {
          const mode = ads.postMode.shift() ?? "ok";
          if (mode === "400") return json({ title: "One or more validation errors occurred." }, 400);
          const id = ads.next++;
          ads.orders.set(body.idExterno, id);
          if (mode === "timeout_created") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
          return json({ pedidoId: id }, 201);
        }
        return json({}, 404);
      }
      if (path === "clientes") {
        const doc = url.searchParams.get("cnpjcpf");
        const items = doc ? ads.clientes.filter((c) => c.cnpjCpf === doc) : ads.clientes;
        return json({ items, page: 1, pageSize: 20, total: items.length, hasNext: false });
      }
      if (path === "prazos") return json([{ codigo: "001", descricao: "A VISTA", parcelas: 1, parcela01: 0, inativo: false }]);
      if (path === "pedidos/status") return json([{ pedidoId: Number(url.searchParams.get("pedidoIds")), status: "Faturado", nf: 1 }]);
      const ext = path.match(/^pedidos\/(.+)$/);
      if (ext) return ads.orders.has(ext[1]) ? json({ pedidoId: ads.orders.get(ext[1]) }) : json({ title: "Not Found" }, 404);
      if (path === "cidades") return json([]);
      if (path === "operacoes") return json([{ codigo: "01", descricao: "VENDA", inativo: false }]);
      if (path === "origem-pedido") return json([{ origem_id: "04", descricao: "LOJA VIRTUAL" }]);
      if (path === "formas-de-pagamento") return json([{ codigo: "05", descricao: "PIX", inativo: false }]);
      if (path === "classes") return json([{ classeId: "02", descricao: "VAREJO", inativo: false }]);
      return json([]);
    }),
  );
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("NUVEMSHOP_")) delete process.env[k];
  delete process.env.ADS_PRODUCTION_WRITE_ENABLED;
});

async function connect() {
  const { authorizationUrl, bindingNonce } = await startAuthorization(sql(), ACTOR);
  const state = new URL(authorizationUrl).searchParams.get("state");
  const r = await handleCallback(sql(), { code: "code-1", state, error: null, bindingNonce, actor: ACTOR }, { fetchImpl: ns.fetch });
  expect(r.ok).toBe(true);
}

async function adsProduct(adsId: number): Promise<number> {
  const [{ id }] = await sql().query<{ id: number }>(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, '{}'::jsonb) RETURNING id`, [adsId, `PRODUTO ${adsId}`]);
  return id;
}

const variantProduct = (id: number, sku: string) => ({
  id,
  name: { pt: `Produto ${id}` },
  images: [],
  variants: [{ id: id * 100, sku, stock: 5, stock_management: true, price: "50.00", promotional_price: null }],
});

/** Pedido Nuvemshop pago com dados de cobrança completos. */
function nsOrder(id: number, over: Partial<FakeOrder> & Record<string, unknown> = {}): FakeOrder {
  return {
    id,
    number: 1001,
    status: "open",
    payment_status: "paid",
    created_at: "2026-11-23T12:00:00-0300",
    updated_at: "2026-11-23T12:05:00-0300",
    paid_at: "2026-11-23T12:04:00-0300",
    subtotal: "100.00",
    discount: "0.00",
    discount_coupon: "10.00",
    discount_gateway: "0.00",
    shipping_cost_customer: "15.00",
    total: "105.00",
    contact_identification: "529.982.247-25",
    contact_name: "Maria Silva",
    contact_email: "Maria@Exemplo.test",
    contact_phone: "+55 41 99999-8888",
    billing_name: "Maria Silva",
    billing_address: "Rua das Flores",
    billing_number: "100",
    billing_floor: "ap 2",
    billing_locality: "Centro",
    billing_zipcode: "80010-000",
    billing_city: "Curitiba",
    billing_province: "Paraná",
    billing_country: "BR",
    products: [{ id: id * 10, product_id: 1, variant_id: 100, quantity: 2, sku: "ADS-77", name: "Produto 1", price: "50.00" }],
    ...over,
  } as FakeOrder;
}

/** Loja conectada, variante 100 vinculada ao produto ADS 77, configuração Nuvemshop salva, pedido 5001 lido. */
async function ready(o: { order?: FakeOrder; settings?: AdsOrderSettings | null; customer?: boolean } = {}) {
  await connect();
  const p = await adsProduct(77);
  ns.products = [variantProduct(1, "ADS-77")];
  await createImportJob(sql(), { mode: "FULL", actor: ACTOR });
  for (let i = 0; i < 20; i++) if (!(await processNuvemshopJobs({ sql: sql(), fetchImpl: ns.fetch, sleep: noSleep, retryBaseMs: 1, budgetMs: 60_000 })).more) break;
  await confirmMapping(sql(), { storeId: NS_STORE, variantId: "100", productId: p, actor: ACTOR });
  if (o.settings !== null) await sql().execute(`INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)`, [settingsKey(undefined, "nuvemshop"), JSON.stringify(o.settings ?? SETTINGS)]);
  if (o.customer !== false) ads.clientes.push({ clienteId: 321, cnpjCpf: CPF });
  const order = o.order ?? nsOrder(5001);
  ns.orders = [order];
  // Chegou pelo webhook (campos antigos, sem comprador).
  await upsertOrder(sql(), NS_STORE, { ...order, contact_identification: undefined } as never, "WEBHOOK");
  return p;
}

const post = (orderId: string, body: unknown) => nsAdsPost(makeRequest(`/api/nuvemshop/orders/${orderId}/ads`, { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body }), ctx(orderId));
const state = async (orderId = "5001") => {
  const r = await nsAdsGet(makeRequest(`/api/nuvemshop/orders/${orderId}/ads`, { cookies: adminCookies() }), ctx(orderId));
  return { status: r.status, body: await r.json() };
};

describe("dados do comprador da Nuvemshop", () => {
  it("lê CPF, nome, endereço de cobrança, UF por nome e telefone com +55", () => {
    const b = parseNsBilling(nsOrder(1) as unknown as Record<string, unknown>);
    expect(b).toMatchObject({
      docType: "CPF",
      docNumber: CPF,
      name: "Maria Silva",
      address: { street: "Rua das Flores", number: "100", complement: "ap 2", neighborhood: "Centro", city: "Curitiba", state: "PR", zip: "80010000", phone: "41999998888", email: "maria@exemplo.test" },
    });
    expect(ufOf("São Paulo")).toBe("SP");
    expect(ufOf("BR-MG")).toBe("MG");
  });

  it("nome completo: billing_name com só o primeiro nome não substitui contact_name", () => {
    // Caso real: a Nuvemshop mandou só "Márcia" em billing_name e o nome completo em contact_name.
    const b = parseNsBilling({ ...(nsOrder(1) as unknown as Record<string, unknown>), billing_name: "Márcia", contact_name: "Márcia  Souza Lima" });
    expect(b.name).toBe("Márcia Souza Lima");
    const c = parseNsBilling({ ...(nsOrder(1) as unknown as Record<string, unknown>), billing_name: "Márcia Souza Lima", contact_name: "Márcia" });
    expect(c.name).toBe("Márcia Souza Lima");
    // Destinatário da entrega não vira nome do cliente quando há endereço de cobrança.
    const d = parseNsBilling({ ...(nsOrder(1) as unknown as Record<string, unknown>), billing_name: "Ana", contact_name: "Ana", shipping_address: { name: "José Carlos da Silva" } });
    expect(d.name).toBe("Ana");
  });

  it("CNPJ usa a razão social; sem endereço de cobrança usa o de entrega", () => {
    const b = parseNsBilling({
      contact_identification: "11.222.333/0001-81",
      billing_business_name: "LOJA X LTDA",
      billing_name: "Fulano",
      billing_state_registration: "ISENTO",
      shipping_address: { address: "Av. Brasil", number: "5", locality: "Jardim", city: "Rio de Janeiro", province: "Rio de Janeiro", zipcode: "20000-000", phone: "2133334444" },
    });
    expect(b).toMatchObject({ docType: "CNPJ", name: "LOJA X LTDA", stateRegistration: "ISENTO", address: { street: "Av. Brasil", state: "RJ", zip: "20000000", phone: "2133334444" } });
  });
});

describe("configuração comercial por canal", () => {
  it("Nuvemshop tem configuração própria; sem ela, sugere a do ML com a tabela F (sem gravar)", async () => {
    await sql().execute(`INSERT INTO price_tables (code, description, raw_payload) VALUES ('M', 'MARKETP', '{}'), ('F', 'FIO', '{}')`);
    await sql().execute(`INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)`, [settingsKey(), JSON.stringify({ ...SETTINGS, tabela: "M", canalId: "03" })]);
    const g = await settingsGet(makeRequest("/api/ads/order-settings?channel=nuvemshop", { cookies: adminCookies() }));
    const body = await g.json();
    expect(body.settings).toBeNull();
    expect(body.suggested).toMatchObject({ tabela: "F", canalId: "03" });
    const p = await settingsPut(makeRequest("/api/ads/order-settings?channel=nuvemshop", { method: "PUT", cookies: adminCookies(), headers: { origin: BASE }, body: SETTINGS }));
    expect(p.status).toBe(200);
    expect(await getAdsOrderSettings(sql(), "nuvemshop")).toMatchObject({ tabela: "F", canalId: "04" });
    // O ML continua com a dele.
    expect(await getAdsOrderSettings(sql())).toMatchObject({ tabela: "M", canalId: "03" });
  });
});

describe("pedido Nuvemshop → ADS", () => {
  it("reler o pedido traz valores e comprador; payload com idExterno N, tabela F, frete e desconto conferidos com o total pago", async () => {
    await ready();
    const before = await state();
    expect(before.body.validation.issues.map((i: { code: string }) => i.code)).toContain("billing_missing");
    const r = await post("5001", { action: "refresh" });
    expect(r.status).toBe(200);
    expect((await r.json()).customerStatus).toBe("FOUND");
    const s = await state();
    expect(s.body.validation.issues.filter((i: { blocking: boolean }) => i.blocking)).toEqual([]);
    expect(s.body.validation.ok).toBe(true);
    expect(s.body.billing.docNumber).not.toContain("52998224725");
    expect(s.body.payload).toMatchObject({
      clienteId: 321,
      idExterno: "N5001",
      pedidoCliente: "1001",
      tabela: "F",
      canalId: "04",
      frete: 15,
      desconto: 10,
      total: 105,
      observacao: "Nuvemshop #1001",
      itens: [{ produtoId: 77, quantidade: 2, precoUnitario: 50, valorLiquido: 100, codigoTabelaDePreco: "F" }],
      parcelas: [{ parcela: 1, valor: 105 }],
    });
    expect(s.body.payload.clienteCnpjCpf).not.toBe(CPF);
  });

  it("API 2025-03: frete do comprador vem do fulfillment order (consumer_cost), não do pedido", async () => {
    // Como no pedido real #1338: sem shipping_cost_customer; total = itens + frete.
    const order = nsOrder(5001, {
      shipping_cost_customer: undefined,
      discount: "0.00",
      discount_coupon: "0.00",
      subtotal: "100.00",
      total: "137.50",
      fulfillments: [{ id: "01F", shipping: { type: "ship", option: { name: "PAC", merchant_cost: { value: "30.00" }, consumer_cost: { value: "37.50", currency: "BRL" } } } }],
    });
    await ready({ order });
    let s = await state();
    expect(s.body.validation.issues.map((i: { code: string }) => i.code)).toContain("values_missing");
    expect(s.body.validation.issues.map((i: { code: string }) => i.code)).not.toContain("ns_total_inconsistent");
    await post("5001", { action: "refresh" });
    s = await state();
    expect(s.body.validation.issues.filter((i: { blocking: boolean }) => i.blocking)).toEqual([]);
    expect(s.body.payload).toMatchObject({ frete: 37.5, desconto: 0, total: 137.5, parcelas: [{ parcela: 1, valor: 137.5 }] });
  });

  it("sem fulfillment nem campo de frete: frete = total − subtotal + desconto", async () => {
    const order = nsOrder(5001, { shipping_cost_customer: undefined, discount: "10.00", discount_coupon: "10.00", subtotal: "100.00", total: "127.50" });
    await ready({ order });
    await post("5001", { action: "refresh" });
    const s = await state();
    expect(s.body.validation.issues.filter((i: { blocking: boolean }) => i.blocking)).toEqual([]);
    expect(s.body.validation.issues.map((i: { code: string }) => i.code)).not.toContain("discount_breakdown");
    expect(s.body.payload).toMatchObject({ frete: 37.5, desconto: 10, total: 127.5 });
  });

  it("envio manual em homologação: POST único, idempotente, e o compromisso de estoque recebe o fato do envio", async () => {
    await ready();
    await post("5001", { action: "refresh" });
    const { body } = await state();
    const bad = await post("5001", { action: "send", confirm: "ENVIAR PRODUCAO", payloadHash: body.payloadHash });
    expect(bad.status).toBe(400);
    const r = await post("5001", { action: "send", confirm: "ENVIAR", payloadHash: body.payloadHash });
    expect(r.status).toBe(200);
    const sub = (await r.json()).submission;
    expect(sub).toMatchObject({ status: "SENT", adsPedidoId: 7001, externalId: "N5001", environment: "homologacao" });
    expect(ads.posts.filter((p) => p.path === "pedidos")).toHaveLength(1);
    expect(ads.posts[0].body.clienteCnpjCpf).toBe(CPF);
    // De novo: não duplica.
    const again = await sendNsOrderToAds(sql(), NS_STORE, "5001", { payloadHash: body.payloadHash, requestedBy: ACTOR });
    expect(again.id).toBe(sub.id);
    expect(ads.posts.filter((p) => p.path === "pedidos")).toHaveLength(1);
    // Política padrão: pedido criado na ADS ainda não comprova a baixa → segue descontado.
    const [res] = await sql().query<{ state: string; adsSub: string; ext: string }>(
      `SELECT state, facts->>'adsSubmission' AS "adsSub", ads_external_id AS ext FROM inventory_reservations WHERE channel = 'nuvemshop' AND external_order_id = '5001'`,
    );
    expect(res).toMatchObject({ state: "PENDING_ERP", adsSub: "SENT", ext: "N5001" });
    // Situação "Faturado" listada como evidência de baixa → refletido, sem baixa dupla.
    await updateInventorySettings(sql(), { adsReflectedStatuses: ["Faturado"] }, ACTOR);
    const st = await post("5001", { action: "status" });
    expect((await st.json()).submission.adsStatus).toBe("Faturado");
    const [after] = await sql().query<{ state: string }>(`SELECT state FROM inventory_reservations WHERE channel = 'nuvemshop' AND external_order_id = '5001'`);
    expect(after.state).toBe("REFLECTED_IN_ERP");
    const [o] = await sql().query<{ c: string }>(`SELECT commitment_state AS c FROM nuvemshop_orders WHERE order_id = 5001`);
    expect(o.c).toBe("REFLECTED_IN_ERP");
    // Lista "Enviados".
    const list = await (await nsOrdersGet(makeRequest("/api/nuvemshop/orders?ads=sent", { cookies: adminCookies() }))).json();
    expect(list.items).toEqual([expect.objectContaining({ orderId: "5001", adsSubmission: "SENT", adsPedidoId: 7001 })]);
    // As chamadas ficam no histórico da Nuvemshop, não no do Mercado Livre.
    expect((await sql().query(`SELECT 1 FROM ads_order_attempts`)).length).toBe(0);
    expect((await sql().query(`SELECT 1 FROM nuvemshop_ads_attempts WHERE operation = 'POST'`)).length).toBe(1);
  });

  it("política 'ADS baixa na criação': o envio confirmado já reflete a baixa", async () => {
    await ready();
    await updateInventorySettings(sql(), { adsDeductsOnOrderCreated: true }, ACTOR);
    await post("5001", { action: "refresh" });
    const { body } = await state();
    await post("5001", { action: "send", confirm: "ENVIAR", payloadHash: body.payloadHash });
    const [res] = await sql().query<{ state: string }>(`SELECT state FROM inventory_reservations WHERE channel = 'nuvemshop' AND external_order_id = '5001'`);
    expect(res.state).toBe("REFLECTED_IN_ERP");
  });

  it("timeout no POST = resultado incerto; a conciliação pelo idExterno resolve sem reenviar", async () => {
    await ready();
    await post("5001", { action: "refresh" });
    const { body } = await state();
    ads.postMode = ["timeout_created"];
    const s = await sendNsOrderToAds(sql(), NS_STORE, "5001", { payloadHash: body.payloadHash, requestedBy: ACTOR });
    expect(s.status).toBe("UNKNOWN");
    const [res] = await sql().query<{ state: string }>(`SELECT state FROM inventory_reservations WHERE channel = 'nuvemshop' AND external_order_id = '5001'`);
    expect(res.state).toBe("REQUIRES_RECONCILIATION");
    await expect(sendNsOrderToAds(sql(), NS_STORE, "5001", { payloadHash: body.payloadHash, requestedBy: ACTOR })).rejects.toMatchObject({ code: "needs_reconcile" });
    const rec = await reconcileNsSubmission(sql(), NS_STORE, "5001");
    expect(rec).toMatchObject({ status: "SENT", adsPedidoId: 7001 });
    expect(ads.posts.filter((p) => p.path === "pedidos")).toHaveLength(1);
  });

  it("recusa da ADS (4xx) = FAILED; pode ser enviado de novo depois de corrigir", async () => {
    await ready();
    await post("5001", { action: "refresh" });
    const { body } = await state();
    ads.postMode = ["400"];
    expect((await sendNsOrderToAds(sql(), NS_STORE, "5001", { payloadHash: body.payloadHash, requestedBy: ACTOR })).status).toBe("FAILED");
    expect((await sendNsOrderToAds(sql(), NS_STORE, "5001", { payloadHash: body.payloadHash, requestedBy: ACTOR })).status).toBe("SENT");
  });

  it("bloqueios: pagamento pendente, sem configuração do canal, payload alterado, variante sem vínculo, kit, baixa já confirmada à mão", async () => {
    await ready({ order: nsOrder(5001, { payment_status: "pending" }), settings: null });
    await post("5001", { action: "refresh" });
    let b = await buildNsAdsOrder(sql(), NS_STORE, "5001");
    expect(b.issues.filter((i) => i.blocking).map((i) => i.code)).toEqual(expect.arrayContaining(["payment_not_paid", "settings_missing"]));
    expect(b.ok).toBe(false);
    await sql().execute(`INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)`, [settingsKey(undefined, "nuvemshop"), JSON.stringify(SETTINGS)]);
    ns.orders = [nsOrder(5001)];
    await post("5001", { action: "refresh" });
    b = await buildNsAdsOrder(sql(), NS_STORE, "5001");
    expect(b.ok).toBe(true);
    await expect(sendNsOrderToAds(sql(), NS_STORE, "5001", { payloadHash: "0".repeat(64), requestedBy: ACTOR })).rejects.toMatchObject({ code: "payload_changed" });
    // Linha com variante não vinculada.
    ns.orders = [nsOrder(5001, { products: [{ id: 1, product_id: 9, variant_id: 999, quantity: 1, sku: "X", price: "100.00" }], updated_at: "2026-11-23T13:00:00-0300" } as never)];
    await post("5001", { action: "refresh" });
    b = await buildNsAdsOrder(sql(), NS_STORE, "5001");
    expect(b.issues.map((i) => i.code)).toContain("unmapped_items");
    // Kit: composição com 2 unidades.
    const comp = await adsProduct(88);
    await sql().execute(`INSERT INTO nuvemshop_mapping_components (mapping_id, product_id, ads_product_id, quantity) SELECT id, $1, 88, 2 FROM nuvemshop_variant_mappings WHERE variant_id = 100`, [comp]);
    ns.orders = [nsOrder(5001, { updated_at: "2026-11-23T14:00:00-0300" } as never)];
    await post("5001", { action: "refresh" });
    b = await buildNsAdsOrder(sql(), NS_STORE, "5001");
    expect(b.lines[0].problem).toMatch(/kit/);
    expect(b.ok).toBe(false);
    // Baixa confirmada manualmente: o pedido provavelmente já está no ADSNET.
    await sql().execute(`DELETE FROM nuvemshop_mapping_components`);
    await post("5001", { action: "refresh" });
    await confirmAdsReflection(sql(), { storeId: NS_STORE, orderId: "5001", actor: ACTOR, reference: "204100" });
    b = await buildNsAdsOrder(sql(), NS_STORE, "5001");
    expect(b.issues.map((i) => i.code)).toContain("ads_confirmed_manually");
  });

  it("totais divergentes bloqueiam (itens ≠ subtotal; total pago ≠ total ADS)", async () => {
    await ready({ order: nsOrder(5001, { subtotal: "90.00", total: "95.00" }) });
    await post("5001", { action: "refresh" });
    const b = await buildNsAdsOrder(sql(), NS_STORE, "5001");
    expect(b.issues.filter((i) => i.blocking).map((i) => i.code)).toContain("subtotal_mismatch");
  });

  it("cliente novo: cadastro com o telefone do comprador da Nuvemshop, registrado no histórico do canal", async () => {
    await ready({ customer: false });
    await sql().execute(`UPDATE nuvemshop_orders SET lines = lines WHERE order_id = 5001`);
    const r = await post("5001", { action: "refresh" });
    expect((await r.json()).customerStatus).toBe("NOT_FOUND");
    const s = await state();
    expect(s.body.customerDraft.missing).toEqual([]);
    expect(s.body.customerDraft.city).toMatchObject({ code: "4106902", name: "Curitiba" });
    expect(s.body.customerDraft.request).toMatchObject({ telefone: "41999998888", email: "maria@exemplo.test", observacao: "Cliente Nuvemshop (integrador)", endereco: { uf: "PR", codigoIbge: "4106902" } });
    const c = await post("5001", { action: "customer_create", confirm: "CADASTRAR" });
    expect((await c.json()).customer).toMatchObject({ status: "CREATED", adsClienteId: 800 });
    expect(ads.posts.find((p) => p.path === "clientes")!.body.cnpjCpf).toBe(CPF);
    expect((await sql().query(`SELECT 1 FROM nuvemshop_ads_attempts WHERE operation = 'CUSTOMER_CREATE'`)).length).toBe(1);
    expect((await state()).body.validation.ok).toBe(true);
  });

  it("produção sem ADS_PRODUCTION_WRITE_ENABLED: envio bloqueado", async () => {
    await ready();
    await post("5001", { action: "refresh" });
    const { body } = await state();
    process.env.ADS_API_BASE_URL = "https://adsapi.com.br";
    const r = await post("5001", { action: "send", confirm: "ENVIAR PRODUCAO", payloadHash: body.payloadHash });
    expect(r.status).toBe(403);
    expect(ads.posts).toHaveLength(0);
  });

  it("customers/redact apaga os dados do comprador dos pedidos indicados; store/redact apaga todos", async () => {
    await ready();
    await post("5001", { action: "refresh" });
    expect((await sql().query(`SELECT 1 FROM nuvemshop_order_billing`)).length).toBe(1);
    const r = await handlePrivacyWebhook(sql(), "customers/redact", { store_id: NS_STORE, orders_to_redact: [5001] });
    expect(r.action).toMatch(/1 pedido/);
    expect((await sql().query(`SELECT 1 FROM nuvemshop_order_billing`)).length).toBe(0);
    await post("5001", { action: "refresh" });
    await handlePrivacyWebhook(sql(), "store/redact", { store_id: NS_STORE });
    expect((await sql().query(`SELECT 1 FROM nuvemshop_order_billing`)).length).toBe(0);
  });
});

describe("filtro fields da Nuvemshop", () => {
  it("não pede shipping_cost_customer (recusado pela Nuvemshop em produção)", () => {
    expect(ORDER_FIELDS.split(",")).not.toContain("shipping_cost_customer");
  });

  it("repete a leitura uma vez sem os campos recusados", async () => {
    const err = new NuvemshopApiError("not_found", "Nuvemshop respondeu 404 (Not Found — Invalid fields for this resource: b, c)", 404);
    expect(invalidFieldsOf(err)).toEqual(["b", "c"]);
    const calls: string[] = [];
    const out = await withFieldFallback("a,b,c,d", async (fields) => {
      calls.push(fields);
      if (calls.length === 1) throw err;
      return fields;
    });
    expect(out).toBe("a,d");
    expect(calls).toEqual(["a,b,c,d", "a,d"]);
  });

  it("não mascara outros erros nem repete sem mudar os campos", async () => {
    const other = new NuvemshopApiError("server", "Nuvemshop respondeu 500", 500);
    await expect(withFieldFallback("a,b", async () => { throw other; })).rejects.toBe(other);
    const unknownField = new NuvemshopApiError("not_found", "Invalid fields for this resource: z", 404);
    let n = 0;
    await expect(withFieldFallback("a,b", async () => { n++; throw unknownField; })).rejects.toBe(unknownField);
    expect(n).toBe(1);
  });
});

describe("frete e desconto do pedido Nuvemshop", () => {
  it("soma consumer_cost dos fulfillment orders em qualquer formato Money", () => {
    expect(nsShippingCost({ fulfillments: [{ shipping: { option: { consumer_cost: { value: "20.00" } } } }, { shipping: { consumer_cost: 5.5 } }] })).toEqual({ value: 25.5, source: "fulfillment" });
    expect(nsShippingCost({ fulfillments: [{ shipping: { option: { consumer_cost: { amount: 0 } } } }], total: "50", subtotal: "40" })).toEqual({ value: 0, source: "fulfillment" });
  });

  it("cai para o campo antigo e depois para a identidade do total", () => {
    expect(nsShippingCost({ shipping_cost_customer: "15.00", total: "1", subtotal: "1" })).toEqual({ value: 15, source: "order_field" });
    expect(nsShippingCost({ subtotal: "34.90", discount: "0.00", total: "72.40" })).toEqual({ value: 37.5, source: "derived" });
    expect(nsShippingCost({ subtotal: "100", total: "120" , discount: "0", discount_coupon: "10" })).toEqual({ value: 30, source: "derived" });
    expect(nsShippingCost({ subtotal: "100", total: "50" })).toEqual({ value: null, source: null });
    expect(nsShippingCost({ total: "50" })).toEqual({ value: null, source: null });
  });

  it("discount já é o total (não soma de novo cupom e meio de pagamento)", () => {
    expect(nsDiscountTotal({ discount: "600.00", discount_coupon: "0.00", discount_gateway: "600.00" })).toBe(600);
    expect(nsDiscountTotal({ discount: "0.00", discount_coupon: "10.00", discount_gateway: "2.00" })).toBe(12);
  });
});
