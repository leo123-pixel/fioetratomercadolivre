import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adsEnvironment } from "@/lib/ads/client";
import { recordOrderEvents } from "@/lib/inventory/ingest";
import { drainOutbox } from "@/lib/inventory/ledger";
import { InventoryCoreDisabledError } from "@/lib/inventory/mode";
import { liveReadDeadline, runShadowReconciliation } from "@/lib/inventory/shadow";
import { saveLocation, savePolicy, updateInventorySettings } from "@/lib/inventory/settings";
import { simulateQuotaTransfer } from "@/lib/inventory/transfer-service";
import { GatedRemoteTransferExecutor } from "@/lib/inventory/transfer";
import { updateGroupPolicy, updateStockSettings } from "@/lib/stock/settings";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";
import { mockStock } from "./helpers/stock-mock";

/**
 * Inventory Core em PostgreSQL real (PGlite com as migrations de produção). ADS e Mercado Livre simulados;
 * por padrão QUALQUER chamada de rede falha o teste (o modo cache não deve sair do banco).
 */
const t = useTestDatabase();
const sql = () => t.sql();
const ACTOR = "admin:teste";
const DEFAULT_POLICY = `INSERT INTO inventory_allocation_policies (scope, version, safety_reserve, remainder_mode, rules, created_by)
  VALUES ('GLOBAL', 1, NULL, 'PRIORITY', '[{"channel":"mercadolivre","type":"PERCENT","value":100,"priority":1},{"channel":"nuvemshop","type":"ZERO","priority":2}]', 'system:migration')`;

let network: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  process.env.INVENTORY_CORE_MODE = "shadow";
  await sql().execute(DEFAULT_POLICY);
  await updateStockSettings(sql(), { branchIds: ["01"] }, ACTOR);
  network = vi.fn(async (input: unknown) => {
    throw new Error(`Chamada de rede inesperada: ${String(input)}`);
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  delete process.env.INVENTORY_CORE_MODE;
});

const env = () => adsEnvironment().environment;

async function product(ads: number, o: { kit?: boolean } = {}): Promise<number> {
  const [{ id }] = await sql().query<{ id: number }>(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, $3::jsonb) RETURNING id`, [ads, `PRODUTO ${ads}`, JSON.stringify({ kit: o.kit ?? false })]);
  return id;
}
async function stock(productId: number, qty: number | string, o: { branch?: string; fetchedAt?: Date } = {}) {
  const [{ ads }] = await sql().query<{ ads: number }>(`SELECT ads_product_id AS ads FROM products WHERE id = $1`, [productId]);
  await sql().execute(
    `INSERT INTO product_stocks (product_id, ads_product_id, branch_id, quantity, raw_payload, fetched_at) VALUES ($1, $2, $3, $4::numeric, '{}'::jsonb, $5::timestamptz)
     ON CONFLICT (ads_product_id, branch_id) DO UPDATE SET quantity = EXCLUDED.quantity, fetched_at = EXCLUDED.fetched_at`,
    [productId, ads, o.branch ?? "01", String(qty), (o.fetchedAt ?? new Date()).toISOString()],
  );
}
async function listing(
  itemId: string,
  productId: number | null,
  o: { qty?: number | null; status?: string; logistic?: string; variationId?: string; upId?: string; components?: { productId: number; quantity: number }[]; maxQuantity?: number } = {},
): Promise<string | null> {
  await sql().execute(
    `INSERT INTO legacy_listings (marketplace_account_id, marketplace_item_id, variation_id, user_product_id, status, available_quantity, logistic_type, origin)
     VALUES ('42', $1, $2, $3, $4, $5, $6, 'EXTERNAL')`,
    [itemId, o.variationId ?? "", o.upId ?? null, o.status ?? "active", o.qty === undefined ? 10 : o.qty, o.logistic ?? null],
  );
  if (!productId) return null;
  const [{ ads }] = await sql().query<{ ads: number }>(`SELECT ads_product_id AS ads FROM products WHERE id = $1`, [productId]);
  const [{ id }] = await sql().query<{ id: string }>(
    `INSERT INTO marketplace_product_mappings (mapping_type, marketplace_item_id, variation_id, product_id, ads_product_id, created_by, max_quantity)
     VALUES ('ITEM', $1, $2, $3, $4, 'admin', $5) RETURNING id::text AS id`,
    [itemId, o.variationId ?? "", productId, ads, o.maxQuantity ?? null],
  );
  for (const c of o.components ?? []) {
    const [{ cads }] = await sql().query<{ cads: number }>(`SELECT ads_product_id AS cads FROM products WHERE id = $1`, [c.productId]);
    await sql().execute(`INSERT INTO marketplace_mapping_components (mapping_id, product_id, ads_product_id, quantity) VALUES ($1::bigint, $2, $3, $4)`, [id, c.productId, cads, c.quantity]);
  }
  return id;
}
async function order(
  orderId: string,
  lines: { itemId: string; productId: number | null; qty: number; mappingId?: string | null }[],
  o: { status?: string; createdAt?: Date; packId?: string } = {},
): Promise<string> {
  const [{ id }] = await sql().query<{ id: string }>(
    `INSERT INTO marketplace_order_inbox (marketplace_order_id, seller_id, order_status, date_created, pack_id) VALUES ($1, '42', $2, $3::timestamptz, $4) RETURNING id::text AS id`,
    [orderId, o.status ?? "paid", (o.createdAt ?? new Date()).toISOString(), o.packId ?? null],
  );
  let n = 0;
  for (const l of lines) {
    await sql().execute(
      `INSERT INTO marketplace_order_items (order_id, line_key, marketplace_item_id, quantity, product_id, mapping_status, mapping_id)
       VALUES ($1::bigint, $2, $3, $4::numeric, $5, $6, $7::bigint)`,
      [id, `L${++n}`, l.itemId, String(l.qty), l.productId, l.productId ? "MAPPED" : "UNMAPPED", l.mappingId ?? null],
    );
  }
  return id;
}
async function submission(inboxId: string, orderId: string, status: string, o: { adsStatus?: string; updatedAt?: Date } = {}) {
  await sql().execute(
    `INSERT INTO ads_order_submissions (order_id, marketplace_order_id, external_id, environment, status, payload, payload_hash, requested_by, ads_pedido_id, ads_status, updated_at)
     VALUES ($1::bigint, $2, $3, $4, $5, '{}'::jsonb, 'h', 'admin', $6, $7, $8::timestamptz)`,
    [inboxId, orderId, `M${orderId}`.slice(0, 17), env(), status, status === "SENT" ? 777 : null, o.adsStatus ?? null, (o.updatedAt ?? new Date()).toISOString()],
  );
}
const run = (o: Partial<Parameters<typeof runShadowReconciliation>[1]> = {}) => runShadowReconciliation(sql(), { requestedBy: ACTOR, ...o });

async function position(productId: number) {
  const [p] = await sql().query<{ id: string; adsStatus: string; ads: string | null; pending: string; reserve: number; safe: number | null; reliability: string; reasons: string[]; mlDesired: number | null; mlConfirmed: number | null; mlStatus: string; nsDesired: number | null; nsStatus: string; version: number }>(
    `SELECT ip.id::text AS id, ip.ads_status AS "adsStatus", trim_scale(ip.ads_quantity)::text AS ads, trim_scale(ip.pending_commitments)::text AS pending, ip.safety_reserve AS reserve,
            ip.safe_sellable AS safe, ip.reliability, ip.reliability_reasons AS reasons, ip.version,
            ml.desired_quantity AS "mlDesired", ml.confirmed_quantity AS "mlConfirmed", ml.status AS "mlStatus", ns.desired_quantity AS "nsDesired", ns.status AS "nsStatus"
     FROM inventory_pools ip
     LEFT JOIN inventory_channel_allocations ml ON ml.pool_id = ip.id AND ml.channel = 'mercadolivre'
     LEFT JOIN inventory_channel_allocations ns ON ns.pool_id = ip.id AND ns.channel = 'nuvemshop'
     WHERE ip.product_id = $1`,
    [productId],
  );
  return p;
}
const reservations = (productId?: number) =>
  sql().query<{ externalOrderId: string; state: string; quantity: string; lineKey: string }>(
    `SELECT external_order_id AS "externalOrderId", state, trim_scale(quantity)::text AS quantity, line_key AS "lineKey" FROM inventory_reservations WHERE ($1::int IS NULL OR product_id = $1) ORDER BY id`,
    [productId ?? null],
  );
const openDiscrepancies = async (type?: string) =>
  (await sql().query<{ type: string; severity: string; message: string }>(`SELECT type, severity, message FROM inventory_discrepancies WHERE status = 'OPEN' AND ($1::text IS NULL OR type = $1) ORDER BY id`, [type ?? null]));
const count = async (table: string) => (await sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

describe("Inventory Core — posição e cotas (modo sombra, cache ADS)", () => {
  it("produto com estoque positivo: disponível seguro vai para o ML; Nuvemshop simulada com zero; nada sai do banco", async () => {
    const p = await product(100);
    await stock(p, 12);
    await listing("MLB1", p, { qty: 12 });
    const r = await run();
    expect(r.status).toBe("COMPLETED");
    expect(r.summary.remoteWrites).toBe(0);
    const pos = await position(p);
    expect(pos).toMatchObject({ adsStatus: "KNOWN", ads: "12", safe: 12, reliability: "RELIABLE", mlDesired: 12, mlConfirmed: 12, mlStatus: "IN_SYNC", nsDesired: 0, nsStatus: "SIMULATED" });
    expect(network).not.toHaveBeenCalled();
    // A sincronização atual não é tocada.
    expect(await count("stock_sync_jobs")).toBe(0);
    expect(await count("stock_sync_runs")).toBe(0);
  });

  it("estoque zero com anúncio ativo: proposta de redução (só sombra) e divergência OVER_EXPOSED", async () => {
    const p = await product(101);
    await stock(p, 0);
    await listing("MLB2", p, { qty: 5 });
    const r = await run();
    const pos = await position(p);
    expect(pos).toMatchObject({ safe: 0, mlDesired: 0, mlConfirmed: 5, mlStatus: "PENDING_REMOTE" });
    expect((await openDiscrepancies("OVER_EXPOSED"))[0].severity).toBe("CRITICAL");
    const [prop] = await sql().query<{ status: string; direction: string; writeBlocked: boolean; target: number }>(
      `SELECT status, direction, write_blocked AS "writeBlocked", target_quantity AS target FROM inventory_sync_proposals WHERE run_id = $1::uuid`,
      [r.runId],
    );
    expect(prop).toEqual({ status: "SHADOW_ONLY", direction: "DECREASE", writeBlocked: true, target: 0 });
    // Outbox gravado na transação e suprimido no modo sombra.
    const outbox = await sql().query<{ status: string }>(`SELECT status FROM inventory_outbox_events`);
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox.every((o) => o.status === "SUPPRESSED_SHADOW")).toBe(true);
  });

  it("estoque desconhecido (sem linha na ADS): nunca vira zero, nenhuma cota", async () => {
    const p = await product(102);
    await listing("MLB3", p, { qty: 4 });
    await run();
    const pos = await position(p);
    expect(pos).toMatchObject({ adsStatus: "UNKNOWN", safe: null, reliability: "UNKNOWN", mlDesired: null, mlStatus: "BLOCKED" });
    expect((await openDiscrepancies("ADS_STOCK_UNKNOWN")).length).toBe(1);
  });

  it("reserva de segurança: herda da sincronização atual e a política própria tem precedência", async () => {
    const p = await product(103);
    await stock(p, 10);
    await listing("MLB4", p, { qty: 10 });
    await updateGroupPolicy(sql(), p, { safetyReserve: 3 }, ACTOR);
    await run();
    expect(await position(p)).toMatchObject({ reserve: 3, safe: 7, mlDesired: 7 });
    await savePolicy(sql(), { productId: p, safetyReserve: 1, remainderMode: "PRIORITY", rules: [{ channel: "mercadolivre", type: "PERCENT", value: 50, priority: 1 }, { channel: "nuvemshop", type: "PERCENT", value: 50, priority: 2 }] }, ACTOR);
    await run();
    // 9 seguros: ML 5 (prioridade leva a sobra) e Nuvemshop simulada 4 — mas ML anuncia 10: reduz primeiro, Nuvemshop espera.
    const pos = await position(p);
    expect(pos).toMatchObject({ reserve: 1, safe: 9, mlDesired: 5, nsDesired: 0 });
  });

  it("múltiplas filiais: só filiais mapeadas no mesmo depósito são somadas", async () => {
    const p = await product(104);
    await stock(p, 5, { branch: "01" });
    await stock(p, 7, { branch: "02" });
    await listing("MLB5", p, { qty: 1 });
    await run();
    expect(await position(p)).toMatchObject({ ads: "5", safe: 5 });
    expect((await openDiscrepancies("UNMAPPED_LOCATION")).length).toBe(1);
    await saveLocation(sql(), { branchId: "02", warehouseCode: "principal", status: "MAPPED" }, ACTOR);
    await run();
    expect(await position(p)).toMatchObject({ ads: "12", safe: 12 });
    // Filial em outro depósito (incompatível): não soma.
    await saveLocation(sql(), { branchId: "02", warehouseCode: "loja_fisica", status: "MAPPED" }, ACTOR);
    await run();
    expect(await position(p)).toMatchObject({ ads: "5" });
  });

  it("nenhuma filial mapeada: pool bloqueado", async () => {
    await updateStockSettings(sql(), { branchIds: null }, ACTOR);
    const p = await product(105);
    await stock(p, 5);
    await listing("MLB6", p);
    await run();
    expect(await position(p)).toMatchObject({ reliability: "BLOCKED", safe: null, mlDesired: null });
    expect((await openDiscrepancies("WAREHOUSE_WITHOUT_BRANCH"))[0].severity).toBe("CRITICAL");
  });

  it("estoque Full não entra na disponibilidade administrada pela ADS", async () => {
    const p = await product(106);
    await stock(p, 3);
    await listing("MLB7", p, { qty: 50, logistic: "fulfillment" });
    await listing("MLB8", p, { qty: 3 });
    await run();
    expect(await position(p)).toMatchObject({ safe: 3, mlConfirmed: 3, mlDesired: 3 });
  });

  it("produto com múltiplos anúncios e variações: cota física única; divisão por anúncio exige regra", async () => {
    const p = await product(107);
    await stock(p, 6);
    await listing("MLB9", p, { qty: 3 });
    await listing("MLB10", p, { qty: 3, variationId: "55" });
    const r = await run();
    expect(await position(p)).toMatchObject({ safe: 6, mlConfirmed: 6, mlDesired: 6 });
    expect((await openDiscrepancies("ALLOCATION_REQUIRED")).length).toBe(1);
    await updateGroupPolicy(sql(), p, { allocationMode: "SPLIT_EVEN" }, ACTOR);
    const r2 = await run();
    const [prop] = await sql().query<{ details: { listings: { key: string; target: number | null }[] } }>(`SELECT details FROM inventory_sync_proposals WHERE run_id = $1::uuid`, [r2.runId]);
    expect(prop.details.listings.map((l) => l.target)).toEqual([3, 3]);
    expect(r.runId).not.toBe(r2.runId);
  });

  it("kit: a venda consome os componentes; a exposição do anúncio-kit conta cada componente", async () => {
    const a = await product(108);
    const b = await product(109);
    const kit = await product(110, { kit: true });
    await stock(a, 10);
    await stock(b, 4);
    const mappingId = await listing("MLB11", kit, { qty: 2, components: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] });
    await order("2001", [{ itemId: "MLB11", productId: kit, qty: 1, mappingId }]);
    await run();
    // Componentes: A reservou 2, B reservou 1. Exposição do kit: 2 kits = 4 A + 2 B.
    expect(await position(a)).toMatchObject({ pending: "2", safe: 8, mlConfirmed: 4 });
    expect(await position(b)).toMatchObject({ pending: "1", safe: 3, mlConfirmed: 2 });
    expect((await reservations()).map((r) => r.quantity)).toEqual(["2", "1"]);
  });

  it("saldo fracionário na ADS: só unidades inteiras, sinalizado", async () => {
    const p = await product(111);
    await stock(p, "3.750");
    await listing("MLB12", p, { qty: 3 });
    await run();
    const pos = await position(p);
    expect(pos.safe).toBe(3);
    expect(pos.reliability).toBe("DEGRADED");
  });
});

describe("Inventory Core — pedidos e compromissos", () => {
  it("venda no ML: reserva PENDING_ERP, desconta do disponível; repetir a execução não duplica nada", async () => {
    const p = await product(200);
    await stock(p, 10);
    await listing("MLB20", p, { qty: 9 });
    await order("3001", [{ itemId: "MLB20", productId: p, qty: 1 }]);
    await run();
    expect(await reservations(p)).toEqual([{ externalOrderId: "3001", state: "PENDING_ERP", quantity: "1", lineKey: "L1" }]);
    expect(await position(p)).toMatchObject({ pending: "1", safe: 9, mlDesired: 9, mlStatus: "IN_SYNC" });
    const movements = await count("inventory_movements");
    const allocations = await sql().query(`SELECT version FROM inventory_channel_allocations`);
    await run();
    await run();
    expect(await reservations(p)).toHaveLength(1);
    // Idempotência: sem novas movimentações nem novas versões de cota quando nada mudou.
    expect(await count("inventory_movements")).toBe(movements);
    expect(await sql().query(`SELECT version FROM inventory_channel_allocations`)).toEqual(allocations);
  });

  it("pedido já baixado na ADS (situação configurada como evidência): não é descontado de novo", async () => {
    const p = await product(201);
    await stock(p, 10);
    await listing("MLB21", p, { qty: 10 });
    const o = await order("3002", [{ itemId: "MLB21", productId: p, qty: 2 }]);
    await submission(o, "3002", "SENT", { adsStatus: "Faturado" });
    await updateInventorySettings(sql(), { adsReflectedStatuses: ["Faturado", "Nota Emitida"] }, ACTOR);
    await run();
    expect((await reservations(p))[0].state).toBe("REFLECTED_IN_ERP");
    expect(await position(p)).toMatchObject({ pending: "0", safe: 10 });
    const types = (await sql().query<{ t: string; r: string }>(`SELECT event_type AS t, responsibility AS r FROM inventory_movements WHERE external_order_id = '3002' ORDER BY id`)).map((m) => `${m.t}/${m.r}`);
    expect(types).toContain("ADS_STOCK_CONFIRMED/OBSERVED");
    expect(types).toContain("STOCK_RECONCILED/INTERNAL");
  });

  it("pedido enviado à ADS sem prova de baixa: continua descontado e diverge do sincronizador atual", async () => {
    const p = await product(202);
    await stock(p, 10);
    await listing("MLB22", p, { qty: 8 });
    const o = await order("3003", [{ itemId: "MLB22", productId: p, qty: 2 }]);
    await submission(o, "3003", "SENT");
    await run();
    expect((await reservations(p))[0].state).toBe("PENDING_ERP");
    expect(await position(p)).toMatchObject({ pending: "2", safe: 8 });
    const [d] = await openDiscrepancies("CURRENT_SYNC_PENDING_DIFFERS");
    expect(d.severity).toBe("WARNING");
    expect(d.message).toMatch(/sincronizador atual 0/);
  });

  it("política 'a ADS baixa na criação': envio SENT reflete (sem desconto duplo)", async () => {
    const p = await product(203);
    await stock(p, 10);
    await listing("MLB23", p, { qty: 10 });
    const o = await order("3004", [{ itemId: "MLB23", productId: p, qty: 3 }]);
    await submission(o, "3004", "SENT");
    await updateInventorySettings(sql(), { adsDeductsOnOrderCreated: true }, ACTOR);
    await run();
    expect(await position(p)).toMatchObject({ pending: "0", safe: 10 });
  });

  it("pack: o envio no pedido principal vale para os demais pedidos do pack", async () => {
    const p = await product(204);
    await stock(p, 10);
    await listing("MLB24", p, { qty: 10 });
    const lead = await order("3005", [{ itemId: "MLB24", productId: p, qty: 1 }], { packId: "PK1" });
    await order("3006", [{ itemId: "MLB24", productId: p, qty: 1 }], { packId: "PK1" });
    await submission(lead, "3005", "SENT", { adsStatus: "Faturado" });
    await updateInventorySettings(sql(), { adsReflectedStatuses: ["Faturado"] }, ACTOR);
    await run();
    expect((await reservations(p)).map((r) => r.state)).toEqual(["REFLECTED_IN_ERP", "REFLECTED_IN_ERP"]);
  });

  it("cancelamento antes da ADS libera; depois do envio exige reconciliação e continua descontado", async () => {
    const p = await product(205);
    await stock(p, 10);
    await listing("MLB25", p, { qty: 10 });
    await order("3007", [{ itemId: "MLB25", productId: p, qty: 1 }], { status: "cancelled" });
    const o = await order("3008", [{ itemId: "MLB25", productId: p, qty: 2 }]);
    await submission(o, "3008", "SENT");
    await run();
    await sql().execute(`UPDATE marketplace_order_inbox SET order_status = 'cancelled' WHERE marketplace_order_id = '3008'`);
    await run();
    expect((await reservations(p)).map((r) => [r.externalOrderId, r.state])).toEqual([
      ["3007", "RELEASED"],
      ["3008", "REQUIRES_RECONCILIATION"],
    ]);
    expect(await position(p)).toMatchObject({ pending: "2", safe: 8, reliability: "DEGRADED" });
    expect((await openDiscrepancies("RESERVATION_RECONCILIATION")).length).toBe(1);
  });

  it("devolução e evento fora de ordem (cancelamento antes do recebimento)", async () => {
    const p = await product(206);
    await stock(p, 5);
    const policy = { adsDeductsOnOrderCreated: false };
    const base = { channel: "mercadolivre", lineKey: "L1", productId: p, quantity: 1, correlationId: "c", warehouseCode: "principal" };
    const first = await recordOrderEvents(sql(), { ...base, externalOrderId: "X1", events: [{ type: "ORDER_CANCELLED" }] }, policy);
    const late = await recordOrderEvents(sql(), { ...base, externalOrderId: "X1", events: [{ type: "ORDER_RECEIVED" }] }, policy);
    expect([first.state, late.state]).toEqual(["RELEASED", "RELEASED"]);
    const ret = await recordOrderEvents(sql(), { ...base, externalOrderId: "X2", events: [{ type: "ORDER_RECEIVED" }] }, policy);
    expect(ret.state).toBe("PENDING_ERP");
    expect((await recordOrderEvents(sql(), { ...base, externalOrderId: "X2", events: [{ type: "ORDER_RETURNED" }] }, policy)).state).toBe("RELEASED");
  });

  it("webhook duplicado / worker reiniciado: o mesmo evento não gera nova reserva nem nova movimentação", async () => {
    const p = await product(207);
    const input = { channel: "mercadolivre", externalOrderId: "X3", lineKey: "L1", productId: p, quantity: 2, correlationId: "c", warehouseCode: "principal", events: [{ type: "ORDER_RECEIVED" as const }] };
    const a = await recordOrderEvents(sql(), input, { adsDeductsOnOrderCreated: false });
    const before = await count("inventory_movements");
    const b = await recordOrderEvents(sql(), input, { adsDeductsOnOrderCreated: false });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, changed: false, reservationId: a.reservationId });
    expect(await count("inventory_movements")).toBe(before);
    expect(await count("inventory_reservations")).toBe(1);
  });

  it("duas vendas simultâneas e o mesmo pedido em dois processos ao mesmo tempo", async () => {
    const p = await product(208);
    await stock(p, 10);
    const mk = (orderId: string) => ({ channel: "mercadolivre", externalOrderId: orderId, lineKey: "L1", productId: p, quantity: 1, correlationId: orderId, warehouseCode: "principal", events: [{ type: "ORDER_RECEIVED" as const }] });
    const policy = { adsDeductsOnOrderCreated: false };
    await Promise.all([recordOrderEvents(sql(), mk("S1"), policy), recordOrderEvents(sql(), mk("S2"), policy), recordOrderEvents(sql(), mk("S1"), policy), recordOrderEvents(sql(), mk("S1"), policy)]);
    expect((await reservations(p)).map((r) => r.externalOrderId).sort()).toEqual(["S1", "S2"]);
    await run({ productIds: [p] });
    expect(await position(p)).toMatchObject({ pending: "2", safe: 8 });
  });

  it("venda Nuvemshop simulada: registrada como simulação, não entra na posição real", async () => {
    const p = await product(209);
    await stock(p, 4);
    const r = await recordOrderEvents(sql(), { channel: "nuvemshop", externalOrderId: "NS-1", lineKey: "1", productId: p, quantity: 3, correlationId: "sim", warehouseCode: "principal", simulated: true, events: [{ type: "ORDER_RECEIVED" }] }, { adsDeductsOnOrderCreated: false });
    expect(r.state).toBe("PENDING_ERP");
    await run({ productIds: [p] });
    expect(await position(p)).toMatchObject({ pending: "0", safe: 4 });
    const [m] = await sql().query<{ origin: string; simulated: boolean }>(`SELECT origin, simulated FROM inventory_movements WHERE external_order_id = 'NS-1' LIMIT 1`);
    expect(m).toEqual({ origin: "SIMULATION", simulated: true });
  });

  it("pedido sem vínculo: não reserva, alerta crítico e bloqueia aumento do produto do anúncio", async () => {
    const p = await product(210);
    await stock(p, 10);
    await listing("MLB30", p, { qty: 2 });
    await order("3010", [{ itemId: "MLB30", productId: null, qty: 1 }]);
    await run();
    expect(await reservations()).toHaveLength(0);
    expect((await openDiscrepancies("UNMAPPED_ORDER_LINE"))[0].severity).toBe("CRITICAL");
    // Degradado: só redução — continua em 2, não sobe para 10.
    expect(await position(p)).toMatchObject({ reliability: "DEGRADED", mlDesired: 2, mlConfirmed: 2 });
  });

  it("pendente há tempo demais: REQUIRES_RECONCILIATION (o sincronizador atual já o ignoraria após 7 dias)", async () => {
    const p = await product(211);
    await stock(p, 10);
    await listing("MLB31", p, { qty: 9 });
    await order("3011", [{ itemId: "MLB31", productId: p, qty: 1 }], { createdAt: new Date(Date.now() - 9 * 86_400_000) });
    await run();
    expect((await reservations(p))[0].state).toBe("REQUIRES_RECONCILIATION");
    expect(await position(p)).toMatchObject({ pending: "1", safe: 9 });
  });
});

describe("Inventory Core — falhas, concorrência, snapshots e transferências", () => {
  it("falha da ADS (leitura ao vivo): erro não vira zero; último saldo preservado; nenhuma cota nova", async () => {
    await seedConnection({ expiresInMs: 3_600_000 });
    const p = await product(300);
    await stock(p, 6, { fetchedAt: new Date(Date.now() - 60_000) });
    await listing("MLB40", p, { qty: 6 });
    await run();
    expect(await position(p)).toMatchObject({ safe: 6, mlDesired: 6 });
    const m = mockStock({ ads: [], adsFail: true });
    await run({ live: true });
    expect(await position(p)).toMatchObject({ adsStatus: "ERROR", ads: "6", safe: null, reliability: "UNKNOWN", mlDesired: null });
    expect((await openDiscrepancies("ADS_UNAVAILABLE"))[0].severity).toBe("CRITICAL");
    expect(m.puts()).toHaveLength(0);
  });

  it("leitura ao vivo bem-sucedida: somente GET; não grava no cache da sincronização atual; snapshot antigo não substitui o novo", async () => {
    const p = await product(301);
    await stock(p, 2, { fetchedAt: new Date(Date.now() - 30 * 60_000) });
    await listing("MLB41", p, { qty: 2 });
    const m = mockStock({ ads: [{ produtoId: 301, filialId: "01", estoque: 9 }] });
    await run({ live: true });
    expect(await position(p)).toMatchObject({ adsStatus: "KNOWN", ads: "9", safe: 9 });
    const methods = m.handler.mock.calls.map(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase());
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((x) => x === "GET")).toBe(true);
    const [cache] = await sql().query<{ q: string }>(`SELECT trim_scale(quantity)::text AS q FROM product_stocks WHERE product_id = $1`, [p]);
    expect(cache.q).toBe("2");
    // Execução seguinte pelo cache (mais antigo que a leitura ao vivo): ignorada, posição mantém 9.
    vi.stubGlobal("fetch", network);
    await run();
    expect(await position(p)).toMatchObject({ ads: "9", safe: 9 });
    const [ignored] = await sql().query<{ status: string }>(`SELECT status FROM inventory_movements WHERE event_type = 'ADS_STOCK_SNAPSHOT' AND status = 'IGNORED_STALE'`);
    expect(ignored.status).toBe("IGNORED_STALE");
  });

  it("prazo curto: sem tempo para a leitura ao vivo, nenhuma consulta à ADS e o cálculo usa o último saldo (não vira ERROR)", async () => {
    const p = await product(302);
    await stock(p, 4, { fetchedAt: new Date(Date.now() - 30 * 60_000) });
    await listing("MLB42", p, { qty: 4 });
    const r = await run({ live: true, deadline: Date.now() + 15_000 });
    expect(network).not.toHaveBeenCalled();
    expect(r.summary).toMatchObject({ liveRead: { read: 0, skipped: 1 }, processedProducts: 1 });
    expect(await position(p)).toMatchObject({ adsStatus: "KNOWN", ads: "4", safe: 4, mlDesired: 4 });
  });

  it("prazo da leitura ao vivo: no máximo metade do restante e folga por produto para o cálculo", () => {
    expect(liveReadDeadline(undefined, 100)).toBeUndefined();
    expect(liveReadDeadline(1_000 + 60_000, 10, 1_000)).toBe(1_000 + 30_000);
    expect(liveReadDeadline(1_000 + 60_000, 300, 1_000)).toBe(1_000 + 10_000);
    expect(liveReadDeadline(1_000 + 20_000, 300, 1_000)).toBe(1_000);
  });

  it("falha do Mercado Livre (quantidade anunciada desconhecida): não confirma nada e não aumenta outros canais", async () => {
    const p = await product(302);
    await stock(p, 8);
    await listing("MLB42", p, { qty: null });
    await savePolicy(sql(), { productId: p, safetyReserve: 0, remainderMode: "PRIORITY", rules: [{ channel: "mercadolivre", type: "PERCENT", value: 50, priority: 1 }, { channel: "nuvemshop", type: "PERCENT", value: 50, priority: 2 }] }, ACTOR);
    await run();
    expect(await position(p)).toMatchObject({ mlConfirmed: null, mlStatus: "UNCONFIRMED", mlDesired: 4, nsDesired: 0, reliability: "DEGRADED" });
  });

  it("dois workers ao mesmo tempo: só um executa (lease); o outro recusa sem efeito", async () => {
    const p = await product(303);
    await stock(p, 3);
    await listing("MLB43", p, { qty: 3 });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("already_running");
    expect(await count("inventory_reconciliation_runs")).toBe(1);
  });

  it("worker reiniciado: lease abandonado expira e a próxima execução retoma sem duplicar", async () => {
    const p = await product(304);
    await stock(p, 5);
    await listing("MLB44", p, { qty: 5 });
    await order("4001", [{ itemId: "MLB44", productId: p, qty: 1 }]);
    await run();
    // Simula uma instância que morreu segurando o lease (já vencido).
    await sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ('inventory-shadow', 'morta', now() - interval '1 minute') ON CONFLICT (name) DO UPDATE SET owner = 'morta', lease_until = now() - interval '1 minute'`);
    await sql().execute(`INSERT INTO inventory_reconciliation_runs (source, requested_by, correlation_id) VALUES ('ADS_CACHE', 'morta', 'x')`);
    const r = await run();
    expect(r.status).toBe("COMPLETED");
    expect(await reservations(p)).toHaveLength(1);
  });

  it("transferência de cota (simulação): reduz a origem antes; cotas reais intactas; uma aberta por pool", async () => {
    const p = await product(305);
    await stock(p, 8);
    await listing("MLB45", p, { qty: 4 });
    await savePolicy(sql(), { productId: p, safetyReserve: 0, remainderMode: "PRIORITY", rules: [{ channel: "mercadolivre", type: "FIXED", value: 4, priority: 1 }, { channel: "nuvemshop", type: "FIXED", value: 4, priority: 2 }] }, ACTOR);
    await run();
    const pos = await position(p);
    expect(pos).toMatchObject({ mlDesired: 4, nsDesired: 4 });
    const ok = await simulateQuotaTransfer(sql(), { poolId: pos.id, fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 2, requestedBy: ACTOR });
    expect(ok.state).toBe("COMPLETED");
    expect(ok.simulated).toBe(true);
    expect(ok.steps.map((s) => s.state)).toEqual(["REQUESTED", "SOURCE_DECREASE_PREPARED", "SOURCE_DECREASE_CONFIRMED", "DESTINATION_INCREASE_PREPARED", "COMPLETED"]);
    expect(await position(p)).toMatchObject({ mlDesired: 4, nsDesired: 4 });

    const blocked = await simulateQuotaTransfer(sql(), { poolId: pos.id, fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 2, requestedBy: ACTOR, outcomes: { sourceDecrease: "failed" } });
    expect(blocked.state).toBe("BLOCKED");
    await expect(simulateQuotaTransfer(sql(), { poolId: pos.id, fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 1, requestedBy: ACTOR })).rejects.toMatchObject({ code: "transfer_open" });
  });

  it("atualização remota incerta e executor real: reconciliação / bloqueio, nunca libera o destino", async () => {
    const p = await product(306);
    await stock(p, 8);
    await listing("MLB46", p, { qty: 4 });
    await savePolicy(sql(), { productId: p, safetyReserve: 0, remainderMode: "PRIORITY", rules: [{ channel: "mercadolivre", type: "FIXED", value: 4, priority: 1 }, { channel: "nuvemshop", type: "FIXED", value: 4, priority: 2 }] }, ACTOR);
    await run();
    const { id } = await position(p);
    const uncertain = await simulateQuotaTransfer(sql(), { poolId: id, fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 2, requestedBy: ACTOR, outcomes: { sourceDecrease: "uncertain" } });
    expect(uncertain.state).toBe("REQUIRES_RECONCILIATION");
    expect(uncertain.steps.some((s) => s.state === "DESTINATION_INCREASE_PREPARED")).toBe(false);
    await sql().execute(`UPDATE inventory_quota_transfers SET state = 'CANCELLED'`);
    const gated = await simulateQuotaTransfer(sql(), { poolId: id, fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 2, requestedBy: ACTOR, executor: new GatedRemoteTransferExecutor() });
    expect(gated.state).toBe("BLOCKED");
    expect(gated.error).toMatch(/Escrita remota bloqueada/);
  });

  it("política: nova versão desativa a anterior; edição baseada em versão antiga é recusada", async () => {
    const rules = [{ channel: "mercadolivre", type: "PERCENT" as const, value: 100, priority: 1 }];
    const v2 = await savePolicy(sql(), { safetyReserve: 1, remainderMode: "PRIORITY", rules, expectedVersion: 1 }, ACTOR);
    expect(v2.version).toBe(2);
    await expect(savePolicy(sql(), { safetyReserve: 2, remainderMode: "PRIORITY", rules, expectedVersion: 1 }, ACTOR)).rejects.toMatchObject({ code: "policy_version_conflict" });
    const active = await sql().query<{ version: number }>(`SELECT version FROM inventory_allocation_policies WHERE active AND scope = 'GLOBAL'`);
    expect(active).toEqual([{ version: 2 }]);
    await expect(savePolicy(sql(), { safetyReserve: 0, remainderMode: "PRIORITY", rules: [{ channel: "desconhecido", type: "ZERO", priority: 1 }] }, ACTOR)).rejects.toMatchObject({ code: "unknown_channel" });
  });

  it("garantias no banco: livro imutável, transferência só simulada, proposta sempre bloqueada, outbox nunca despachado", async () => {
    const p = await product(307);
    await stock(p, 1);
    await listing("MLB47", p, { qty: 1 });
    await run();
    await expect(sql().execute(`UPDATE inventory_movements SET quantity = 0`)).rejects.toThrow(/somente inclusão/);
    await expect(sql().execute(`DELETE FROM inventory_movements`)).rejects.toThrow(/somente inclusão/);
    const { id } = await position(p);
    await expect(
      sql().execute(`INSERT INTO inventory_quota_transfers (pool_id, from_channel, to_channel, quantity, state, simulated, requested_by, idempotency_key, correlation_id) VALUES ($1::bigint, 'a1', 'b1', 1, 'REQUESTED', false, 'x', 'k', 'c')`, [id]),
    ).rejects.toThrow();
    await expect(sql().execute(`UPDATE inventory_sync_proposals SET write_blocked = false`)).rejects.toThrow();
    await expect(sql().execute(`UPDATE inventory_outbox_events SET status = 'DISPATCHED'`)).rejects.toThrow();
  });
});

describe("Inventory Core — desativação e bloqueio estrutural de escrita", () => {
  it("desativado (INVENTORY_CORE_MODE ausente): não executa e não grava nada", async () => {
    delete process.env.INVENTORY_CORE_MODE;
    const p = await product(400);
    await stock(p, 3);
    await listing("MLB50", p);
    await expect(run()).rejects.toBeInstanceOf(InventoryCoreDisabledError);
    for (const table of ["inventory_reconciliation_runs", "inventory_pools", "inventory_movements", "inventory_reservations", "inventory_skus"]) expect(await count(table)).toBe(0);
    expect(await drainOutbox(sql())).toEqual({ suppressed: 0 });
  });

  it("modo inválido (ex.: active) também não executa", async () => {
    process.env.INVENTORY_CORE_MODE = "active";
    await expect(run()).rejects.toBeInstanceOf(InventoryCoreDisabledError);
  });

  it("nenhum módulo do Inventory Core importa ou chama escrita do ML, da ADS ou do sincronizador atual", () => {
    const roots = ["src/lib/inventory", "src/app/api/inventory"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(f)) files.push(full);
      }
    };
    for (const r of roots) walk(join(process.cwd(), r));
    expect(files.length).toBeGreaterThan(5);
    const forbidden = [/\bexecuteWrite\b/, /\bbuildWrite\b/, /\bprocessStockJobs\b/, /\bapplyProposals\b/, /\brunAutoStockSync\b/, /\bsendOrderToAds\b/, /\badsCall\b/, /\bmeliRequest\b/, /\bupsertStocks\b/, /\bfetchAdsStocks\b/, /\benqueueWrite\b/, /\bprocessWriteJobs\b/, /\bissueWritePermit\b/, /\.send(<[^>]*>)?\(/,/method:\s*["'](PUT|POST|PATCH|DELETE)["']/,
      // pg_advisory_xact_lock devolve void: via $queryRawUnsafe o Prisma falha em produção (o PGlite aceita). Usar execute().
      /\.query(<[^>]*>)?\(\s*`SELECT pg_advisory/];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of forbidden) expect({ file: f, match: re.test(text) ? re.source : null }).toEqual({ file: f, match: null });
    }
  });
});
