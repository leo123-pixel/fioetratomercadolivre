import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { setSqlForTesting, type Sql } from "@/lib/sql";

/**
 * PostgreSQL embarcado (PGlite) com as MESMAS migrations de produção. Permite testar UPSERT,
 * ON CONFLICT, índices únicos parciais, FKs e CHECKs de verdade, sem servidor externo.
 */
type Queryable = Pick<PGlite, "query"> | Transaction;

function wrap(q: Queryable, db: PGlite): Sql {
  const sql: Sql = {
    query: async <T>(text: string, params: unknown[] = []) => (await q.query<T>(text, params)).rows,
    execute: async (text: string, params: unknown[] = []) => (await q.query(text, params)).affectedRows ?? 0,
    transaction: <T>(fn: (tx: Sql) => Promise<T>) =>
      q === db ? db.transaction((tx) => fn(wrap(tx, db))) : fn(sql),
  };
  return sql;
}

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

export async function createTestDatabase(): Promise<{ db: PGlite; sql: Sql }> {
  const db = new PGlite();
  for (const dir of readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  return { db, sql: wrap(db, db) };
}

const TABLES = [
  "stock_sync_history",
  "stock_sync_attempts",
  "stock_sync_jobs",
  "stock_sync_proposals",
  "stock_sync_runs",
  "stock_sync_groups",
  "legacy_listing_rejections",
  "legacy_listings",
  "marketplace_mapping_components",
  "ads_order_attempts",
  "ads_order_submissions",
  "ads_customers",
  "marketplace_order_billing",
  "marketplace_product_mappings",
  "marketplace_order_raw",
  "marketplace_shipments",
  "marketplace_order_payments",
  "marketplace_order_items",
  "marketplace_order_inbox",
  "marketplace_reconciliation_issues",
  "marketplace_listing_snapshots",
  "marketplace_sync_jobs",
  "marketplace_event_processing_errors",
  "marketplace_webhook_events",
  "marketplace_listing_events",
  "marketplace_publication_attempts",
  "marketplace_publication_jobs",
  "marketplace_listings",
  "marketplace_category_cache",
  "import_job_errors",
  "import_jobs",
  "worker_leases",
  "listing_drafts",
  "product_images",
  "product_stocks",
  "product_prices",
  "products",
  "price_tables",
  "ads_suppliers",
  "ads_divisions",
  "app_settings",
];

/** Registra um banco por arquivo de teste, limpo antes de cada teste. */
export function useTestDatabase(): { sql: () => Sql; db: () => PGlite } {
  let ctx: { db: PGlite; sql: Sql };
  beforeAll(async () => {
    ctx = await createTestDatabase();
  }, 60_000);
  beforeEach(async () => {
    await ctx.db.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    setSqlForTesting(ctx.sql);
  });
  afterAll(async () => {
    setSqlForTesting(null);
    await ctx?.db.close();
  });
  return { sql: () => ctx.sql, db: () => ctx.db };
}
