import { describe, expect, it } from "vitest";
import { pruneSyncHistory } from "@/lib/maintenance/retention";
import { useTestDatabase } from "./helpers/pg";

/** Retenção do histórico de sincronização: só diagnóstico antigo sai; o que telas e rotinas leem fica. */
const t = useTestDatabase();
const sql = () => t.sql();
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const far = () => Date.now() + 60_000;

async function ids(table: string): Promise<string[]> {
  return (await sql().query<{ id: string }>(`SELECT id::text AS id FROM ${table} ORDER BY id`)).map((r) => r.id);
}

describe("Retenção do histórico de sincronização", () => {
  it("Nuvemshop: apaga decisões antigas, mantém a última de cada variante×tipo, as recentes e as ligadas a escrita por 30 dias", async () => {
    const [{ id: run }] = await sql().query<{ id: string }>(`INSERT INTO nuvemshop_sync_runs (kind, mode, trigger, requested_by) VALUES ('STOCK', 'AUTOMATIC', 'scheduler', 'teste') RETURNING id::text AS id`);
    const item = async (variant: number, kind: string, days: number, job: string | null = null) =>
      (
        await sql().query<{ id: string }>(
          `INSERT INTO nuvemshop_sync_items (run_id, kind, store_id, nuvemshop_product_id, variant_id, decision, job_id, created_at)
           VALUES ($1::uuid, $2, 'S1', 1, $3, 'BLOCKED', $4::uuid, $5::timestamptz) RETURNING id::text AS id`,
          [run, kind, variant, job, ago(days)],
        )
      )[0].id;
    const oldA = await item(100, "STOCK", 10);
    const lastA = await item(100, "STOCK", 9); // a mais recente da variante, mesmo antiga: fica
    const oldPrice = await item(100, "PRICE", 10); // a última de PRICE: fica
    const oldB = await item(200, "STOCK", 5);
    const recentB = await item(200, "STOCK", 1);
    const withJob = await item(300, "STOCK", 10, "00000000-0000-4000-8000-000000000001");
    const withJobOld = await item(300, "STOCK", 40, "00000000-0000-4000-8000-000000000002");
    await item(300, "STOCK", 0);
    const r = await pruneSyncHistory(sql(), { deadline: far(), force: true });
    expect(r).toMatchObject({ ran: true, complete: true, deleted: { nuvemshop_sync_items: 3 } });
    const left = await ids("nuvemshop_sync_items");
    expect(left).toEqual(expect.arrayContaining([lastA, oldPrice, recentB, withJob]));
    for (const gone of [oldA, oldB, withJobOld]) expect(left).not.toContain(gone);
  });

  it("estoque ML: mantém a última por estoque, a última com modelo conhecido, as abertas e as ligadas a atualização", async () => {
    const [{ id: run }] = await sql().query<{ id: string }>(`INSERT INTO stock_sync_runs (mode, requested_by) VALUES ('AUTO', 'teste') RETURNING id::text AS id`);
    const prop = async (pool: string, days: number, o: { model?: string; status?: string } = {}) =>
      (
        await sql().query<{ id: string }>(
          `INSERT INTO stock_sync_proposals (run_id, pool_key, marketplace_item_ids, stock_model, eligible, status, created_at)
           VALUES ($1::uuid, $2, ARRAY['MLB1'], $3, true, $4, $5::timestamptz) RETURNING id::text AS id`,
          [run, pool, o.model ?? "UP_SELLING_ITEM", o.status ?? "APPLIED", ago(days)],
        )
      )[0].id;
    const old1 = await prop("up:1", 20);
    const knownModel = await prop("up:1", 15); // última com modelo conhecido: fica
    const lastUnknown = await prop("up:1", 10, { model: "UNKNOWN", status: "SKIPPED" }); // última do estoque: fica
    const open = await prop("up:2", 20, { status: "PROPOSED" });
    const linked = await prop("up:2", 19);
    await sql().execute(`INSERT INTO stock_sync_jobs (proposal_id, pool_key, sync_mode, status, authorized_by, idempotency_key, target_quantity) VALUES ($1::bigint, 'up:2', 'AUTO', 'SUCCEEDED', 'teste', 'k1', 3)`, [linked]);
    const old2 = await prop("up:2", 18);
    const fiveDays = await prop("up:2", 5); // passou dos 3 dias: sai
    const recent = await prop("up:2", 1);
    const r = await pruneSyncHistory(sql(), { deadline: far(), force: true });
    expect(r.deleted.stock_sync_proposals).toBe(3);
    const left = await ids("stock_sync_proposals");
    expect(left).toEqual(expect.arrayContaining([knownModel, lastUnknown, open, linked, recent]));
    expect(left).not.toContain(old1);
    expect(left).not.toContain(old2);
    expect(left).not.toContain(fiveDays);
  });

  it("preço ML: preços aplicados e propostas em aberto ficam; a última de cada anúncio fica; o resto antigo sai", async () => {
    const [{ id: run }] = await sql().query<{ id: string }>(`INSERT INTO price_sync_runs (requested_by, price_table_code) VALUES ('teste', 'M') RETURNING id::text AS id`);
    const prop = async (item: string, days: number, status: string, applied = false) =>
      (
        await sql().query<{ id: string }>(
          `INSERT INTO price_sync_proposals (run_id, marketplace_item_id, price_table_code, eligible, status, applied_at, created_at)
           VALUES ($1::uuid, $2, 'M', true, $3, $4::timestamptz, $5::timestamptz) RETURNING id::text AS id`,
          [run, item, status, applied ? ago(days) : null, ago(days)],
        )
      )[0].id;
    const applied = await prop("MLB1", 30, "APPLIED", true);
    const inSync = await prop("MLB1", 20, "IN_SYNC");
    const open = await prop("MLB1", 15, "PROPOSED");
    const last = await prop("MLB1", 10, "IN_SYNC");
    const r = await pruneSyncHistory(sql(), { deadline: far(), force: true });
    expect(r.deleted.price_sync_proposals).toBe(1);
    expect(await ids("price_sync_proposals")).toEqual([applied, open, last].sort((a, b) => Number(a) - Number(b)));
    expect(await ids("price_sync_proposals")).not.toContain(inSync);
  });

  it("roda no máximo 1×/h; incompleta (sem tempo) continua no tick seguinte", async () => {
    const first = await pruneSyncHistory(sql(), { deadline: far() });
    expect(first.ran).toBe(true);
    expect((await pruneSyncHistory(sql(), { deadline: far() })).ran).toBe(false);
    const noTime = await pruneSyncHistory(sql(), { deadline: Date.now(), force: true });
    expect(noTime).toMatchObject({ ran: true, complete: false });
    expect((await pruneSyncHistory(sql(), { deadline: far() })).ran).toBe(true);
    const later = new Date(Date.now() + 61 * 60_000);
    expect((await pruneSyncHistory(sql(), { deadline: far(), now: later })).ran).toBe(true);
  });
});
