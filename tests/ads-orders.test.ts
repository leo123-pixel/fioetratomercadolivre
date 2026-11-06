import { describe, expect, it, vi } from "vitest";
import { GET as adsStateRoute, POST as adsActionRoute } from "@/app/api/orders/[id]/ads/route";
import { POST as mappingsRoute } from "@/app/api/mappings/route";
import { AdsWriteBlockedError } from "@/lib/ads/client";
import { saveAdsOrderSettings, settingsKey, type AdsOrderSettings } from "@/lib/ads/commercial";
import { createAdsCustomer, lookupAdsCustomer } from "@/lib/ads/customers";
import { buildAdsOrder, externalIdFor } from "@/lib/ads/order-payload";
import { reconcileSubmission, refreshAdsStatus, sendOrderToAds } from "@/lib/ads/order-submission";
import { fetchOrderBilling, parseBillingInfo, validDocument } from "@/lib/marketplace/billing";
import { saveMapping } from "@/lib/marketplace/mappings";
import { processOrder } from "@/lib/marketplace/orders";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { order as mlOrder, SELLER } from "./helpers/meli-events-mock";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";

const t = useTestDatabase();
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const HOM = "https://hom.adsapi.com.br";
const CPF = "52998224725";

const SETTINGS: AdsOrderSettings = {
  operacaoId: "01",
  canalId: "03",
  formaDePagamentoId: "05",
  prazoId: "001",
  representanteId: null,
  tabela: "F",
  categoriaItem: "N",
  freightMode: "none",
  discountMode: "none",
  itemPriceMode: "sale_price",
  dueDateBase: "payment_approved",
  customerSetorId: "01",
  customerClasseId: "02",
  customerDefaultPhone: "4133334444",
  customerDefaultEmail: null,
};

type AdsPost = { path: string; body: unknown };
interface World {
  orders: Map<string, Record<string, unknown>>;
  billing: Record<string, unknown>;
  clientes: { clienteId: number; cnpjCpf: string; setorId?: string; nome?: string }[];
  adsOrders: Map<string, number>;
  adsPosts: AdsPost[];
  adsGets: string[];
  mlCalls: { method: string; path: string }[];
  postMode: ("ok" | "timeout" | "400" | "500" | "timeout_created")[];
  nextPedido: number;
}

/** ML (somente leitura) + ADS simulados em um único fetch. Nenhuma rede real. */
function mockWorld(over: Partial<World> = {}): World {
  const w: World = {
    orders: new Map(),
    billing: {
      buyer: {
        billing_info: {
          name: "Maria",
          last_name: "Silva",
          identification: { type: "CPF", number: CPF },
          address: { street_name: "Rua das Flores", street_number: "100", city_name: "São Paulo", state: { code: "BR-SP", name: "São Paulo" }, zip_code: "01001-000", neighborhood: "Centro" },
          taxes: { taxpayer_type: { description: "Consumidor Final" } },
        },
      },
    },
    clientes: [],
    adsOrders: new Map(),
    adsPosts: [],
    adsGets: [],
    mlCalls: [],
    postMode: [],
    nextPedido: 9001,
    ...over,
  };
  const json = (b: unknown, status = 200) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.origin === "https://api.mercadolibre.com") {
        w.mlCalls.push({ method, path: url.pathname });
        if (method !== "GET") throw new Error(`Escrita no ML: ${method} ${url.pathname}`);
        const o = url.pathname.match(/^\/orders\/(\d+)$/);
        if (o) return w.orders.has(o[1]) ? json(w.orders.get(o[1])) : json({ message: "not found" }, 404);
        if (url.pathname.startsWith("/orders/billing-info/MLB/")) return json(w.billing);
        if (url.pathname.startsWith("/shipments/")) return json({ message: "not found" }, 404);
        return json({ message: "não simulado" }, 599);
      }
      if (url.origin === HOM || url.origin === "https://ads.test" || url.origin === "https://adsapi.com.br") {
        const path = url.pathname.replace(/^\/api\/v1\/\d+\//, "");
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "null"));
          w.adsPosts.push({ path, body });
          if (path === "clientes") {
            const id = 500 + w.clientes.length;
            w.clientes.push({ clienteId: id, cnpjCpf: body.cnpjCpf });
            return json({ clienteId: id }, 201);
          }
          if (path === "pedidos") {
            const mode = w.postMode.shift() ?? "ok";
            if (mode === "timeout") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
            if (mode === "timeout_created") {
              w.adsOrders.set(body.idExterno, w.nextPedido++);
              throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
            }
            if (mode === "400") return json({ title: "One or more validation errors occurred.", errors: { Itens: ["Produto inexistente"] } }, 400);
            if (mode === "500") return json({ message: "erro interno" }, 500);
            const id = w.nextPedido++;
            w.adsOrders.set(body.idExterno, id);
            return json({ pedidoId: id }, 201);
          }
          return json({}, 404);
        }
        w.adsGets.push(path + url.search);
        if (path === "clientes") {
          const doc = url.searchParams.get("cnpjcpf");
          const items = doc ? w.clientes.filter((c) => c.cnpjCpf === doc) : w.clientes;
          return json({ items, page: 1, pageSize: 20, total: items.length, hasNext: false });
        }
        if (path === "cidades") return json([{ cidade_id: "1", descricao: "SAO PAULO", uf: "SP", codigoIbge: "3550308", datahora: "2020-01-01T00:00:00" }]);
        if (path === "prazos") return json([{ codigo: "001", descricao: "30 DIAS", parcelas: 1, parcela01: 30, inativo: false }]);
        if (path === "pedidos/status") return json([{ pedidoId: Number(url.searchParams.get("pedidoIds")), status: "Em analise", nf: 0 }]);
        const ext = path.match(/^pedidos\/(.+)$/);
        if (ext) return w.adsOrders.has(ext[1]) ? json({ pedidoId: w.adsOrders.get(ext[1]) }) : json({ title: "Not Found" }, 404);
        if (path === "operacoes") return json([{ codigo: "01", descricao: "VENDA", inativo: false }]);
        if (path === "origem-pedido") return json([{ origem_id: "03", descricao: "MARKETPLACE" }]);
        if (path === "formas-de-pagamento") return json([{ codigo: "05", descricao: "MERCADO PAGO", inativo: false }]);
        if (path === "representantes") return json([{ codigo: "R1", nome: "REP", inativo: false, usuario: "x", senha: "NAO-DEVE-SAIR" }]);
        if (path === "classes") return json([{ classeId: "02", descricao: "VAREJO", inativo: false }]);
        return json([], 200);
      }
      throw new Error(`Chamada inesperada: ${url.href}`);
    }),
  );
  return w;
}

async function seedProduct(ads: number, price = "99.90") {
  const sql = t.sql();
  const [{ id }] = await sql.query<{ id: number }>(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, '{}') RETURNING id`, [ads, `PRODUTO ${ads}`]);
  await sql.execute(`INSERT INTO price_tables (code, description, raw_payload) VALUES ('F', 'FIO & TRATO', '{}') ON CONFLICT DO NOTHING`);
  await sql.execute(`INSERT INTO product_prices (product_id, ads_product_id, branch_id, price_table_code, price, raw_payload) VALUES ($1, $2, '01', 'F', $3::numeric, '{}')`, [id, ads, price]);
  return id;
}

async function seedPublishedListing(itemId: string, ads: number) {
  const sql = t.sql();
  const productId = await seedProduct(ads);
  const [{ id: draftId }] = await sql.query<{ id: number }>(`INSERT INTO listing_drafts (product_id, status) VALUES ($1, 'PUBLISHED') RETURNING id`, [productId]);
  await sql.execute(
    `INSERT INTO marketplace_listings (product_id, ads_product_id, listing_draft_id, marketplace_account_id, marketplace_item_id, category_id, price, quantity, status)
     VALUES ($1, $2, $3, $4, $5, 'MLB264861', 99.9, 3, 'active')`,
    [productId, ads, draftId, SELLER, itemId],
  );
  return productId;
}

async function saveSettings(s: AdsOrderSettings = SETTINGS) {
  await t.sql().execute(`INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [settingsKey(), JSON.stringify(s)]);
}

/** Pedido pago, item mapeado, comprador identificado na ADS: pronto para enviar. */
async function readyOrder(w: World, orderId = "2000019348156016", over: Record<string, unknown> = {}) {
  await seedConnection({ expiresInMs: 3_600_000 });
  if (!(await t.sql().query(`SELECT 1 FROM marketplace_listings WHERE marketplace_item_id = 'MLB1000'`)).length) await seedPublishedListing("MLB1000", 1804);
  await saveSettings();
  w.orders.set(orderId, mlOrder(orderId, { pack_id: 2000015871728059, shipping: null, buyer: { id: 777, nickname: "COMPRADOR", billing_info: { id: "BI123" } }, ...over }));
  if (!w.clientes.some((c) => c.cnpjCpf === CPF)) w.clientes.push({ clienteId: 321, cnpjCpf: CPF });
  await processOrder(t.sql(), orderId);
  const [{ id }] = await t.sql().query<{ id: string }>(`SELECT id::text AS id FROM marketplace_order_inbox WHERE marketplace_order_id = $1`, [orderId]);
  const billing = await fetchOrderBilling(t.sql(), id);
  await lookupAdsCustomer(t.sql(), billing.docNumber!, id);
  return id;
}

function useHomologation() {
  process.env.ADS_API_BASE_URL = HOM;
}

describe("dados fiscais do comprador (billing info)", () => {
  it("novo endpoint: lê documento, nome e endereço; valida CPF/CNPJ", () => {
    const b = parseBillingInfo({ buyer: { billing_info: { name: "Maria", last_name: "Silva", identification: { type: "CPF", number: "529.982.247-25" }, address: { street_name: "Rua A", street_number: "1", city_name: "São Paulo", state: { code: "BR-SP" }, zip_code: "01001000", neighborhood: "Centro" } } } }, "BI1");
    expect(b).toMatchObject({ docType: "CPF", docNumber: CPF, name: "Maria Silva", address: { state: "SP", zip: "01001000" } });
    expect(validDocument(CPF)).toBe(true);
    expect(validDocument("11111111111")).toBe(false);
    expect(validDocument("11222333000181")).toBe(true);
  });

  it("formato legado (additional_info) também é aceito", () => {
    const b = parseBillingInfo({ billing_info: { doc_type: "CNPJ", doc_number: "11222333000181", additional_info: [{ type: "BUSINESS_NAME", value: "LOJA X LTDA" }, { type: "STATE_REGISTRATION", value: "123" }] } }, null);
    expect(b).toMatchObject({ docType: "CNPJ", name: "LOJA X LTDA", stateRegistration: "123" });
  });

  it("dados fiscais incompletos: registra o que falta e bloqueia o envio; nada é inventado", async () => {
    const w = mockWorld();
    useHomologation();
    w.billing = { buyer: { billing_info: { name: "Maria", identification: { type: "CPF", number: CPF }, address: { city_name: "São Paulo" } } } };
    const id = await readyOrder(w);
    const b = await fetchOrderBilling(t.sql(), id);
    expect(b.status).toBe("INCOMPLETE");
    expect(b.missing).toEqual(expect.arrayContaining(["endereco.rua", "endereco.numero", "endereco.cep", "endereco.uf"]));
    // Sem cliente na ADS e sem endereço: o cadastro é recusado sem nenhum POST.
    w.clientes.length = 0;
    await lookupAdsCustomer(t.sql(), CPF, id);
    await expect(createAdsCustomer(t.sql(), id, SETTINGS, "admin:test")).rejects.toMatchObject({ code: "incomplete" });
    expect(w.adsPosts).toHaveLength(0);
  });
});

describe("cliente na ADS", () => {
  it("cliente existente: vinculado pelo CPF e usado como clienteId no pedido", async () => {
    const w = mockWorld();
    const id = await readyOrder(w);
    const built = await buildAdsOrder(t.sql(), id);
    expect(built.customer).toMatchObject({ status: "FOUND", adsClienteId: 321 });
    expect(built.payload).toMatchObject({ clienteId: 321, clienteCnpjCpf: CPF });
  });

  it("cliente inexistente: prepara o cadastro, cadastra em homologação uma única vez (sem duplicar)", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    w.clientes.length = 0;
    expect((await lookupAdsCustomer(t.sql(), CPF, id)).status).toBe("NOT_FOUND");
    const c = await createAdsCustomer(t.sql(), id, SETTINGS, "admin:test");
    expect(c).toMatchObject({ status: "CREATED", adsClienteId: 500 });
    const post = w.adsPosts.find((p) => p.path === "clientes")!.body as Record<string, unknown>;
    expect(post).toMatchObject({ cnpjCpf: CPF, setorId: "01", classeId: "02", telefone: "4133334444", endereco: { codigoIbge: "3550308", cep: "01001000", uf: "SP" } });
    expect(String(post.observacao)).toContain("Telefone/e-mail da loja");
    await createAdsCustomer(t.sql(), id, SETTINGS, "admin:test");
    expect(w.adsPosts.filter((p) => p.path === "clientes")).toHaveLength(1);
  });
});

describe("mapeamento de produtos", () => {
  it("produto mapeado pelo anúncio publicado: item do pedido usa o produtoId ADS", async () => {
    const w = mockWorld();
    const id = await readyOrder(w);
    const built = await buildAdsOrder(t.sql(), id);
    expect(built.payload?.itens).toEqual([
      { produtoId: 1804, categoria: "N", codigoTabelaDePreco: "F", quantidade: 1, precoUnitario: 99.9, precoTabela: 99.9, percentualDesconto: 0, valorLiquido: 99.9, observacao: null },
    ]);
    expect(built.ok).toBe(true);
  });

  it("produto não mapeado: UNMAPPED, sem vínculo por título, e o envio fica bloqueado", async () => {
    const w = mockWorld();
    const id = await readyOrder(w, "2000000000000777", { order_items: [{ item: { id: "MLB7777", title: "PRODUTO 1804", seller_sku: "XYZ-1" }, quantity: 2, unit_price: 49.95 }], total_amount: 99.9 });
    const [o] = await t.sql().query<{ mapping: string; ads: string }>(`SELECT mapping_status AS mapping, ads_import_status AS ads FROM marketplace_order_inbox WHERE id = $1`, [id]);
    expect(o).toEqual({ mapping: "UNMAPPED", ads: "READY_FOR_MAPPING" });
    const built = await buildAdsOrder(t.sql(), id);
    expect(built.issues.map((i) => i.code)).toContain("unmapped_items");
    expect(built.ok).toBe(false);
  });

  it("mapeamento manual do anúncio: atualiza o pedido e é reutilizado em pedidos futuros", async () => {
    const w = mockWorld();
    const id = await readyOrder(w, "2000000000000777", { order_items: [{ item: { id: "MLB7777", title: "X", seller_sku: null }, quantity: 2, unit_price: 49.95 }], total_amount: 99.9 });
    const productId = await seedProduct(4321);
    const r = await saveMapping(t.sql(), { scope: "ITEM", itemId: "MLB7777", productId, createdBy: "admin:test" });
    expect(r.remapped).toMatchObject({ mapped: 1, orders: 1 });
    const [o] = await t.sql().query<{ mapping: string; ads: string }>(`SELECT mapping_status AS mapping, ads_import_status AS ads FROM marketplace_order_inbox WHERE id = $1`, [id]);
    expect(o).toEqual({ mapping: "MAPPED", ads: "READY_FOR_ADS" });
    // Pedido novo do mesmo anúncio já chega mapeado (ITEM_LINK).
    w.orders.set("2000000000000888", mlOrder("2000000000000888", { order_items: [{ item: { id: "MLB7777", seller_sku: null }, quantity: 1, unit_price: 49.95 }], total_amount: 49.95, shipping: null }));
    await processOrder(t.sql(), "2000000000000888");
    const [line] = await t.sql().query<{ method: string; ads: number }>(
      `SELECT i.mapping_method AS method, i.ads_product_id AS ads FROM marketplace_order_items i JOIN marketplace_order_inbox o ON o.id = i.order_id WHERE o.marketplace_order_id = '2000000000000888'`,
    );
    expect(line).toEqual({ method: "ITEM_LINK", ads: 4321 });
  });

  it("SKU validado e associação só da linha (MANUAL, preservada ao reler o pedido)", async () => {
    const w = mockWorld();
    const id = await readyOrder(w, "2000000000000999", { order_items: [{ item: { id: "MLB5555", seller_sku: "FT-OX-20" }, quantity: 1, unit_price: 10 }, { item: { id: "MLB6666", seller_sku: null }, quantity: 1, unit_price: 89.9 }], total_amount: 99.9 });
    const p1 = await seedProduct(1111);
    const p2 = await seedProduct(2222);
    await saveMapping(t.sql(), { scope: "SKU", sellerSku: "FT-OX-20", productId: p1, createdBy: "admin:test" });
    await saveMapping(t.sql(), { scope: "ORDER_LINE", orderInboxId: id, lineKey: "MLB6666:", productId: p2, createdBy: "admin:test" });
    await processOrder(t.sql(), "2000000000000999");
    const lines = await t.sql().query<{ item: string; method: string; ads: number }>(`SELECT marketplace_item_id AS item, mapping_method AS method, ads_product_id AS ads FROM marketplace_order_items WHERE order_id = $1 ORDER BY id`, [id]);
    expect(lines).toEqual([
      { item: "MLB5555", method: "SKU_LINK", ads: 1111 },
      { item: "MLB6666", method: "MANUAL", ads: 2222 },
    ]);
  });

  it("rota de mapeamento exige administrador e mesma origem", async () => {
    mockWorld();
    expect((await mappingsRoute(makeRequest("/api/mappings", { method: "POST", body: { scope: "ITEM", productId: 1, itemId: "MLB1" } }))).status).toBe(401);
    expect((await mappingsRoute(makeRequest("/api/mappings", { method: "POST", cookies: adminCookies(), body: { scope: "ITEM", productId: 1, itemId: "MLB1" } }))).status).toBe(403);
  });
});

describe("validação do pedido", () => {
  it("pagamento não aprovado e pedido cancelado bloqueiam", async () => {
    const w = mockWorld();
    const a = await readyOrder(w, "2000000000000101", { status: "payment_required", payments: [{ id: 1, status: "pending" }] });
    expect((await buildAdsOrder(t.sql(), a)).issues.map((i) => i.code)).toContain("payment_not_approved");
    const b = await readyOrder(w, "2000000000000102", { status: "cancelled" });
    expect((await buildAdsOrder(t.sql(), b)).issues.map((i) => i.code)).toContain("order_cancelled");
  });

  it("divergência de valores entre itens e total do pedido ML bloqueia", async () => {
    const w = mockWorld();
    const id = await readyOrder(w, "2000000000000103", { total_amount: 120 });
    const built = await buildAdsOrder(t.sql(), id);
    expect(built.issues.find((i) => i.code === "ml_total_mismatch")?.blocking).toBe(true);
    expect(built.ok).toBe(false);
  });

  it("totais, parcelas, idExterno (≤17) e referências: pedido e pack não são confundidos", async () => {
    const w = mockWorld();
    const id = await readyOrder(w);
    const built = await buildAdsOrder(t.sql(), id);
    expect(built.externalId).toBe("M2000019348156016");
    expect(built.externalId.length).toBeLessThanOrEqual(17);
    expect(externalIdFor("123456789012345678901")).toHaveLength(17);
    expect(built.payload).toMatchObject({ total: 99.9, desconto: 0, frete: 0, pedidoCliente: "2000019348156016", observacao: "ML 2000019348156016 pack 2000015871728059" });
    expect(built.payload!.parcelas).toEqual([{ parcela: 1, vencimento: expect.stringMatching(/^2026-12-05/), valor: 99.9 }]);
  });

  it("configuração comercial: códigos são validados contra a ADS (inexistente é recusado; senha de representante nunca sai)", async () => {
    mockWorld();
    await seedProduct(1804);
    await expect(saveAdsOrderSettings(t.sql(), { ...SETTINGS, operacaoId: "99" })).rejects.toMatchObject({ issues: [{ field: "operacaoId" }] });
    await expect(saveAdsOrderSettings(t.sql(), SETTINGS)).resolves.toMatchObject({ operacaoId: "01" });
    const { fetchCommercialOptions } = await import("@/lib/ads/commercial");
    expect(JSON.stringify(await fetchCommercialOptions(t.sql()))).not.toContain("NAO-DEVE-SAIR");
  });
});

describe("envio manual para a ADS (homologação)", () => {
  it("envio bem-sucedido: confirma pedidoId da ADS, registra histórico e consulta a situação", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    const built = await buildAdsOrder(t.sql(), id);
    const s = await sendOrderToAds(t.sql(), id, { payloadHash: built.payloadHash!, requestedBy: "admin:test" });
    expect(s).toMatchObject({ status: "SENT", adsPedidoId: 9001, externalId: "M2000019348156016", environment: "homologacao" });
    expect(w.adsPosts.filter((p) => p.path === "pedidos")).toHaveLength(1);
    expect(JSON.stringify(s.payload)).not.toContain(CPF); // payload registrado com documento mascarado
    expect((await refreshAdsStatus(t.sql(), id)).adsStatus).toBe("Em analise");
    // Nada é escrito no Mercado Livre.
    expect(w.mlCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("pedido duplicado: segundo envio não faz novo POST; idExterno já existente na ADS também não", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
    await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" });
    const again = await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" });
    expect(again.status).toBe("SENT");
    expect(w.adsPosts.filter((p) => p.path === "pedidos")).toHaveLength(1);

    const id2 = await readyOrder(w, "2000000000000555");
    w.adsOrders.set("M2000000000000555", 7777); // criado na ADS por outro caminho
    const s2 = await sendOrderToAds(t.sql(), id2, { payloadHash: (await buildAdsOrder(t.sql(), id2)).payloadHash!, requestedBy: "admin:test" });
    expect(s2).toMatchObject({ status: "SENT", adsPedidoId: 7777 });
    expect(w.adsPosts.filter((p) => p.path === "pedidos")).toHaveLength(1);
  });

  it("timeout: resultado desconhecido, sem reenvio automático; conciliação pelo idExterno resolve", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
    w.postMode.push("timeout_created");
    expect((await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).status).toBe("UNKNOWN");
    await expect(sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).rejects.toMatchObject({ code: "needs_reconcile" });
    expect(w.adsPosts.filter((p) => p.path === "pedidos")).toHaveLength(1);
    expect(await reconcileSubmission(t.sql(), id)).toMatchObject({ status: "SENT", adsPedidoId: 9001 });
  });

  it("timeout sem criação: conciliação não encontra, encerra como FAILED e permite novo envio explícito", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
    w.postMode.push("timeout");
    await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" });
    expect((await reconcileSubmission(t.sql(), id)).status).toBe("FAILED");
    expect((await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).status).toBe("SENT");
  });

  it("erro da ADS (400): FAILED com a resposta registrada; 500: UNKNOWN", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
    w.postMode.push("400");
    const s = await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" });
    expect(s.status).toBe("FAILED");
    expect(s.lastError).toContain("Produto inexistente");
    w.postMode.push("500");
    expect((await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).status).toBe("UNKNOWN");
    const attempts = await t.sql().query<{ op: string; status: number | null }>(`SELECT operation AS op, http_status AS status FROM ads_order_attempts WHERE operation = 'POST' ORDER BY id`);
    expect(attempts).toEqual([
      { op: "POST", status: 400 },
      { op: "POST", status: 500 },
    ]);
  });

  it("payload alterado depois da visualização é recusado", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    await expect(sendOrderToAds(t.sql(), id, { payloadHash: "0".repeat(64), requestedBy: "admin:test" })).rejects.toMatchObject({ code: "payload_changed" });
    expect(w.adsPosts).toHaveLength(0);
  });

  it("bloqueio de escrita fora da homologação (produção) e com ADS_WRITE_DISABLED", async () => {
    const w = mockWorld();
    process.env.ADS_API_BASE_URL = "https://adsapi.com.br";
    const id = await readyOrder(w);
    const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
    await expect(sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).rejects.toBeInstanceOf(AdsWriteBlockedError);
    await expect(createAdsCustomer(t.sql(), id, SETTINGS, "admin:test")).rejects.toBeInstanceOf(AdsWriteBlockedError);
    useHomologation();
    process.env.ADS_WRITE_DISABLED = "true";
    try {
      await expect(sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).rejects.toBeInstanceOf(AdsWriteBlockedError);
    } finally {
      delete process.env.ADS_WRITE_DISABLED;
    }
    expect(w.adsPosts).toHaveLength(0);
    // Pela rota: 403.
    process.env.ADS_API_BASE_URL = "https://adsapi.com.br";
    const res = await adsActionRoute(makeRequest(`/api/orders/${id}/ads`, { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "send", confirm: "ENVIAR", payloadHash: hash } }), ctx({ id }));
    expect(res.status).toBe(403);
  });

  it("rota: exige administrador, mesma origem e confirmação explícita; estado não expõe o CPF completo", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    expect((await adsStateRoute(makeRequest(`/api/orders/${id}/ads`), ctx({ id }))).status).toBe(401);
    const noConfirm = await adsActionRoute(makeRequest(`/api/orders/${id}/ads`, { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "send", payloadHash: "a".repeat(64) } }), ctx({ id }));
    expect(noConfirm.status).toBe(400);
    const state = await adsStateRoute(makeRequest(`/api/orders/${id}/ads`, { cookies: adminCookies() }), ctx({ id }));
    const text = await state.text();
    expect(state.status).toBe(200);
    expect(text).not.toContain(CPF);
    expect(JSON.parse(text).validation.ok).toBe(true);
    expect(w.adsPosts).toHaveLength(0); // consultar estado nunca escreve na ADS
  });
});

describe("mapeamento assistido: busca por palavras e sugestões por código de barras", () => {
  it("busca de produto aceita palavras em qualquer ordem", async () => {
    mockWorld();
    await t.sql().execute(`INSERT INTO products (ads_product_id, name_original, ean, raw_payload) VALUES (7001, 'MATRIX SPRAY MIRACLE CREATOR 190ML', '7899706196442', '{}')`);
    const { GET: productsList } = await import("@/app/api/products/route");
    const search = async (q: string) =>
      (await (await productsList(makeRequest(`/api/products?q=${encodeURIComponent(q)}`, { cookies: adminCookies() }))).json()).items.map((i: { adsProductId: number }) => i.adsProductId);
    expect(await search("spray matrix miracle")).toEqual([7001]);
    expect(await search("matrix 190ml")).toEqual([7001]);
    expect(await search("matrix shampoo")).toEqual([]);
  });

  it("sugere o produto ADS com o mesmo EAN do GTIN do anúncio e confirma em lote", async () => {
    const w = mockWorld();
    const id = await readyOrder(w, "2000000000000700", { order_items: [{ item: { id: "MLB7542614106", title: "Spray Matrix", seller_sku: "matrix-miracle" }, quantity: 1, unit_price: 99.9 }] });
    await t.sql().execute(`INSERT INTO products (ads_product_id, name_original, ean, raw_payload) VALUES (7001, 'MATRIX SPRAY MIRACLE CREATOR 190ML', '07899706196442', '{}')`);
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === "https://api.mercadolibre.com" && url.pathname === "/items") {
          return new Response(JSON.stringify([{ code: 200, body: { id: "MLB7542614106", attributes: [{ id: "GTIN", value_name: "7899706196442" }] } }]), { status: 200 });
        }
        return original(input, init);
      }),
    );
    const { suggestByBarcode } = await import("@/lib/marketplace/mappings");
    const [s] = await suggestByBarcode(t.sql());
    expect(s).toMatchObject({ itemId: "MLB7542614106", gtins: ["7899706196442"], candidates: [{ adsProductId: 7001 }] });
    const { POST: bulk } = await import("@/app/api/mappings/bulk/route");
    const res = await bulk(makeRequest("/api/mappings/bulk", { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { items: [{ itemId: "MLB7542614106", productId: s.candidates[0].productId }] } }));
    expect(res.status).toBe(200);
    expect((await res.json()).remapped).toMatchObject({ mapped: 1, orders: 1 });
    const [o] = await t.sql().query<{ mapping: string }>(`SELECT mapping_status AS mapping FROM marketplace_order_inbox WHERE id = $1`, [id]);
    expect(o.mapping).toBe("MAPPED");
  });
});

describe("setor do cliente (sem rota própria na ADS)", () => {
  it("lista os setores em uso pelos clientes da ADS, sem dados pessoais, e recusa setor inexistente no ambiente", async () => {
    const w = mockWorld();
    await seedProduct(1804);
    w.clientes.push({ clienteId: 1, cnpjCpf: "11222333000181", setorId: "10", nome: "CLIENTE PESSOA REAL" }, { clienteId: 2, cnpjCpf: CPF, setorId: "10" }, { clienteId: 3, cnpjCpf: "52998224700", setorId: "20" });
    const { fetchCommercialOptions } = await import("@/lib/ads/commercial");
    const o = await fetchCommercialOptions(t.sql());
    expect(o.setores).toEqual([
      { code: "10", label: "usado por 2 cliente(s) ativo(s)" },
      { code: "20", label: "usado por 1 cliente(s) ativo(s)" },
    ]);
    expect(o.setoresComplete).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(/CLIENTE PESSOA REAL|11222333000181/);
    await expect(saveAdsOrderSettings(t.sql(), { ...SETTINGS, customerSetorId: "681" })).rejects.toMatchObject({ issues: [{ field: "customerSetorId" }] });
    await expect(saveAdsOrderSettings(t.sql(), { ...SETTINGS, customerSetorId: "10" })).resolves.toMatchObject({ customerSetorId: "10" });
  });
});

describe("telefone do cliente (ADS exige; ML não informa)", () => {
  it("sem telefone do comprador e sem telefone padrão: cadastro bloqueado antes de chamar a ADS", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    w.clientes.length = 0;
    await lookupAdsCustomer(t.sql(), CPF, id);
    await expect(createAdsCustomer(t.sql(), id, { ...SETTINGS, customerDefaultPhone: null }, "admin:test")).rejects.toMatchObject({ code: "incomplete" });
    expect(w.adsPosts).toHaveLength(0);
  });

  it("telefone do comprador, quando o ML informa, tem prioridade; número mascarado é descartado", () => {
    const real = parseBillingInfo({ buyer: { billing_info: { identification: { type: "CPF", number: CPF }, phone: { area_code: "41", number: "99998888" } } } }, null);
    expect(real.address.phone).toBe("4199998888");
    const masked = parseBillingInfo({ buyer: { billing_info: { identification: { type: "CPF", number: CPF }, phone: { area_code: "XX", number: "XXXXXXX" } } } }, null);
    expect(masked.address.phone).toBeNull();
  });

  it("telefone padrão inválido é recusado na configuração", async () => {
    mockWorld();
    await seedProduct(1804);
    await expect(saveAdsOrderSettings(t.sql(), { ...SETTINGS, customerDefaultPhone: "123" })).rejects.toMatchObject({ issues: [{ field: "customerDefaultPhone" }] });
  });
});

describe("produção: trava explícita e separação por ambiente", () => {
  const PROD = "https://adsapi.com.br";

  it("produção sem ADS_PRODUCTION_WRITE_ENABLED: bloqueada; com a variável: envia e registra o ambiente", async () => {
    const w = mockWorld();
    process.env.ADS_API_BASE_URL = PROD;
    const id = await readyOrder(w);
    const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
    await expect(sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" })).rejects.toBeInstanceOf(AdsWriteBlockedError);
    process.env.ADS_PRODUCTION_WRITE_ENABLED = "true";
    try {
      const sub = await sendOrderToAds(t.sql(), id, { payloadHash: hash, requestedBy: "admin:test" });
      expect(sub).toMatchObject({ status: "SENT", environment: "producao" });
    } finally {
      delete process.env.ADS_PRODUCTION_WRITE_ENABLED;
    }
  });

  it("produção exige a confirmação reforçada ENVIAR PRODUCAO", async () => {
    const w = mockWorld();
    process.env.ADS_API_BASE_URL = PROD;
    process.env.ADS_PRODUCTION_WRITE_ENABLED = "true";
    try {
      const id = await readyOrder(w);
      const hash = (await buildAdsOrder(t.sql(), id)).payloadHash!;
      const call = (confirm: string) =>
        adsActionRoute(makeRequest(`/api/orders/${id}/ads`, { method: "POST", cookies: adminCookies(), headers: { origin: BASE }, body: { action: "send", confirm, payloadHash: hash } }), ctx({ id }));
      expect((await call("ENVIAR")).status).toBe(400);
      expect(w.adsPosts).toHaveLength(0);
      expect((await call("ENVIAR PRODUCAO")).status).toBe(200);
      expect(w.adsPosts.filter((x) => x.path === "pedidos")).toHaveLength(1);
    } finally {
      delete process.env.ADS_PRODUCTION_WRITE_ENABLED;
    }
  });

  it("o que foi feito na homologação não vale na produção: cliente, configuração e envio são separados", async () => {
    const w = mockWorld();
    useHomologation();
    const id = await readyOrder(w);
    const sent = await sendOrderToAds(t.sql(), id, { payloadHash: (await buildAdsOrder(t.sql(), id)).payloadHash!, requestedBy: "admin:test" });
    expect(sent).toMatchObject({ status: "SENT", environment: "homologacao" });

    process.env.ADS_API_BASE_URL = PROD;
    const before = await buildAdsOrder(t.sql(), id);
    // Sem configuração validada na produção e sem cliente identificado na produção: bloqueado.
    expect(before.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["settings_missing", "customer_not_identified"]));
    expect(before.customer).toBeNull();

    process.env.ADS_PRODUCTION_WRITE_ENABLED = "true";
    try {
      await saveSettings();
      await lookupAdsCustomer(t.sql(), CPF, id);
      const after = await buildAdsOrder(t.sql(), id);
      expect(after.ok).toBe(true);
      // O envio da homologação não impede (nem é confundido com) o envio da produção.
      const prodSub = await sendOrderToAds(t.sql(), id, { payloadHash: after.payloadHash!, requestedBy: "admin:test" });
      expect(prodSub).toMatchObject({ status: "SENT", environment: "producao" });
      expect(prodSub.id).not.toBe(sent.id);
    } finally {
      delete process.env.ADS_PRODUCTION_WRITE_ENABLED;
    }
  });
});

describe("operações comerciais", () => {
  it("junta as operações das consultas com e sem o filtro mobile (sem duplicar)", async () => {
    mockWorld();
    await seedProduct(1804);
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/operacoes")) {
          const m = url.searchParams.get("mobile");
          const ops = m === "false" ? [{ codigo: "001", descricao: "VENDA DE MERCADORIA", inativo: false }, { codigo: "908", descricao: "VENDA MOBILE", inativo: false }] : [{ codigo: "908", descricao: "VENDA MOBILE", inativo: false }];
          return new Response(JSON.stringify(ops), { status: 200, headers: { "content-type": "application/json" } });
        }
        return original(input, init);
      }),
    );
    const { fetchCommercialOptions } = await import("@/lib/ads/commercial");
    const o = await fetchCommercialOptions(t.sql());
    expect(o.operacoes.map((x) => x.code)).toEqual(["001", "908"]);
  });
});

describe("cliente inativo na ADS", () => {
  it("cliente criado/encontrado como inativo: aviso na validação (a API não permite ativar)", async () => {
    const w = mockWorld();
    const id = await readyOrder(w);
    (w.clientes[0] as unknown as { inativo: boolean }).inativo = true;
    await lookupAdsCustomer(t.sql(), CPF, id);
    const built = await buildAdsOrder(t.sql(), id);
    expect(built.issues).toContainEqual(expect.objectContaining({ code: "customer_inactive", blocking: false }));
  });
});

describe("código IBGE da cidade", () => {
  it("usa a lista oficial do IBGE guardada no projeto, sem depender de rede", async () => {
    mockWorld();
    useHomologation();
    const { resolveIbge } = await import("@/lib/ads/customers");
    const original = globalThis.fetch;
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        hosts.push(url.hostname);
        return original(input, init);
      }),
    );
    // A ADS simulada só conhece "SAO PAULO": Ipaussu vem da lista oficial, sem nenhuma chamada externa.
    expect(await resolveIbge("Ipaussu", "SP")).toBe("3520905");
    expect(await resolveIbge("São Paulo", "SP")).toBe("3550308");
    expect(await resolveIbge("SAO JOSE DOS CAMPOS", "SP")).toBe("3549904");
    expect(hosts).toEqual([]);
    // Nome inexistente: tenta a ADS e, sem correspondência exata, não inventa.
    expect(await resolveIbge("Cidade Inexistente", "SP")).toBeNull();
    expect(hosts.every((h) => h !== "servicodados.ibge.gov.br")).toBe(true);
  });
});

describe("ADS momentaneamente indisponível", () => {
  it("consultas (GET) são repetidas em 503; envio (POST) nunca é repetido automaticamente", async () => {
    mockWorld();
    useHomologation();
    const { adsCall } = await import("@/lib/ads/client");
    const original = globalThis.fetch;
    const calls: string[] = [];
    let failures = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin === HOM) {
          calls.push(`${init?.method ?? "GET"} ${url.pathname.split("/").pop()}`);
          if (failures-- > 0) return new Response("Service Unavailable", { status: 503 });
          return new Response("[]", { status: 200 });
        }
        return original(input, init);
      }),
    );
    expect((await adsCall("GET", "prazos")).status).toBe(200);
    expect(calls).toEqual(["GET prazos", "GET prazos", "GET prazos"]);
    calls.length = 0;
    failures = 1;
    expect((await adsCall("POST", "pedidos", { body: {} })).status).toBe(503);
    expect(calls).toEqual(["POST pedidos"]);
  });
});

describe("ADS lenta", () => {
  it("consulta que esgota o tempo não é repetida (evita estourar o limite da função)", async () => {
    mockWorld();
    useHomologation();
    const { adsCall } = await import("@/lib/ads/client");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      }),
    );
    await expect(adsCall("GET", "prazos")).rejects.toMatchObject({ kind: "timeout" });
    expect(calls).toBe(1);
  });
});
