import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as discrepanciesGet } from "@/app/api/inventory/discrepancies/route";
import { GET as movementsGet } from "@/app/api/inventory/movements/route";
import { GET as overviewGet } from "@/app/api/inventory/overview/route";
import { PUT as policyPut } from "@/app/api/inventory/policy/route";
import { GET as positionsGet } from "@/app/api/inventory/positions/route";
import { GET as reservationsGet } from "@/app/api/inventory/reservations/route";
import { GET as runGet } from "@/app/api/inventory/runs/[id]/route";
import { POST as runsPost } from "@/app/api/inventory/runs/route";
import { PATCH as settingsPatch } from "@/app/api/inventory/settings/route";
import { POST as simulatePost } from "@/app/api/inventory/simulate/route";
import { POST as transfersPost } from "@/app/api/inventory/transfers/route";
import { updateStockSettings } from "@/lib/stock/settings";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { useTestDatabase } from "./helpers/pg";

const t = useTestDatabase();
const ORIGIN = { origin: BASE };
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const admin = (path: string, init: { method?: string; body?: unknown; origin?: boolean } = {}) =>
  makeRequest(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), cookies: adminCookies(), headers: init.origin === false ? {} : ORIGIN, body: init.body });

beforeEach(async () => {
  process.env.INVENTORY_CORE_MODE = "shadow";
  await t.sql().execute(`INSERT INTO inventory_allocation_policies (scope, version, safety_reserve, remainder_mode, rules, created_by)
    VALUES ('GLOBAL', 1, NULL, 'PRIORITY', '[{"channel":"mercadolivre","type":"PERCENT","value":100,"priority":1},{"channel":"nuvemshop","type":"ZERO","priority":2}]', 'system:migration')`);
  await updateStockSettings(t.sql(), { branchIds: ["01"] }, "admin:teste");
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("rede não permitida");
  }));
});
afterEach(() => {
  delete process.env.INVENTORY_CORE_MODE;
});

async function seedPool() {
  const [{ id }] = await t.sql().query<{ id: number }>(`INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES (900, 'PRODUTO 900', '{}') RETURNING id`);
  await t.sql().execute(`INSERT INTO product_stocks (product_id, ads_product_id, branch_id, quantity, raw_payload) VALUES ($1, 900, '01', 10, '{}')`, [id]);
  await t.sql().execute(`INSERT INTO legacy_listings (marketplace_account_id, marketplace_item_id, status, available_quantity, origin) VALUES ('42', 'MLB900', 'active', 10, 'EXTERNAL')`);
  await t.sql().execute(`INSERT INTO marketplace_product_mappings (mapping_type, marketplace_item_id, product_id, ads_product_id, created_by) VALUES ('ITEM', 'MLB900', $1, 900, 'admin')`, [id]);
  return id;
}

describe("rotas /api/inventory", () => {
  it("exigem sessão de administrador; rotas que gravam exigem a mesma origem", async () => {
    expect((await overviewGet(makeRequest("/api/inventory/overview"))).status).toBe(401);
    expect((await runsPost(makeRequest("/api/inventory/runs", { method: "POST", body: {} }))).status).toBe(401);
    expect((await runsPost(admin("/api/inventory/runs", { body: {}, origin: false }))).status).toBe(403);
    expect((await simulatePost(admin("/api/inventory/simulate", { body: { rules: [], origin: false } as never, origin: false }))).status).toBe(403);
  });

  it("reconciliação pela API: modo sombra, zero escritas remotas, propostas bloqueadas", async () => {
    await seedPool();
    const res = await runsPost(admin("/api/inventory/runs", { body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ mode: "SHADOW", remoteWrites: 0 });
    const detail = await (await runGet(admin(`/api/inventory/runs/${body.runId}`), ctx({ id: body.runId }))).json();
    expect(detail.proposals.every((p: { writeBlocked: boolean }) => p.writeBlocked)).toBe(true);
    const positions = await (await positionsGet(admin("/api/inventory/positions?q=ADS-900"))).json();
    expect(positions.rows[0]).toMatchObject({ skuCode: "ADS-900", safeSellable: 10, mlDesired: 10, mlConfirmed: 10, nsDesired: 0, reliability: "RELIABLE" });
    const overview = await (await overviewGet(admin("/api/inventory/overview"))).json();
    expect(overview.mode).toMatchObject({ mode: "shadow", remoteWritesEnabled: false });
    expect((await (await movementsGet(admin("/api/inventory/movements?q=ADS-900"))).json()).movements.length).toBeGreaterThan(0);
    expect((await discrepanciesGet(admin("/api/inventory/discrepancies?status=OPEN"))).status).toBe(200);
    expect((await reservationsGet(admin("/api/inventory/reservations?state=PENDING_ERP,REQUIRES_RECONCILIATION"))).status).toBe(200);
    expect((await reservationsGet(admin("/api/inventory/reservations?state=QUALQUER"))).status).toBe(400);
  });

  it("Inventory Core desativado: reconciliação e transferência recusadas (409), sem gravar nada", async () => {
    delete process.env.INVENTORY_CORE_MODE;
    const id = await seedPool();
    const res = await runsPost(admin("/api/inventory/runs", { body: {} }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("inventory_core_disabled");
    expect((await transfersPost(admin("/api/inventory/transfers", { body: { poolId: "1", fromChannel: "mercadolivre", toChannel: "nuvemshop", quantity: 1 } }))).status).toBe(409);
    const [{ n }] = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_pools`);
    expect(n).toBe(0);
    expect(id).toBeGreaterThan(0);
  });

  it("simulador: exemplo 10/2 → 4+4; 1 unidade vai para um canal só; nada é gravado", async () => {
    const before = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_movements`);
    const rules = [
      { channel: "mercadolivre", type: "PERCENT", value: 50, priority: 1 },
      { channel: "nuvemshop", type: "PERCENT", value: 50, priority: 2 },
    ];
    const r = await (await simulatePost(admin("/api/inventory/simulate", { body: { adsQuantity: 10, safetyReserve: 2, rules } }))).json();
    expect(r.simulated).toBe(true);
    expect(r.position.safeSellable).toBe(8);
    expect(r.plan.map((p: { desired: number }) => p.desired)).toEqual([4, 4]);
    const one = await (await simulatePost(admin("/api/inventory/simulate", { body: { adsQuantity: 3, safetyReserve: 2, rules } }))).json();
    expect(one.plan.map((p: { desired: number }) => p.desired)).toEqual([1, 0]);
    const unknown = await (await simulatePost(admin("/api/inventory/simulate", { body: { adsQuantity: null, rules } }))).json();
    expect(unknown.plan.every((p: { desired: number | null }) => p.desired === null)).toBe(true);
    const bad = await simulatePost(admin("/api/inventory/simulate", { body: { adsQuantity: 3, rules: [{ channel: "mercadolivre", type: "PERCENT", value: 200, priority: 1 }] } }));
    expect(bad.status).toBe(422);
    expect(await t.sql().query(`SELECT count(*)::int AS n FROM inventory_movements`)).toEqual(before);
  });

  it("política e configuração: validação e controle de versão", async () => {
    const ok = await policyPut(admin("/api/inventory/policy", { method: "PUT", body: { safetyReserve: 1, remainderMode: "PRIORITY", rules: [{ channel: "mercadolivre", type: "PERCENT", value: 100, priority: 1 }], expectedVersion: 1 } }));
    expect(ok.status).toBe(200);
    const stale = await policyPut(admin("/api/inventory/policy", { method: "PUT", body: { safetyReserve: 1, remainderMode: "PRIORITY", rules: [{ channel: "mercadolivre", type: "PERCENT", value: 100, priority: 1 }], expectedVersion: 1 } }));
    expect(stale.status).toBe(409);
    expect((await settingsPatch(admin("/api/inventory/settings", { method: "PATCH", body: { adsReflectedStatuses: ["Faturado"] } }))).status).toBe(200);
    expect((await settingsPatch(admin("/api/inventory/settings", { method: "PATCH", body: { remoteWrites: true } }))).status).toBe(400);
  });
});
