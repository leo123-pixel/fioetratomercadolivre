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
  "nuvemshop_write_attempts",
  "nuvemshop_write_jobs",
  "nuvemshop_sync_items",
  "nuvemshop_sync_runs",
  "nuvemshop_sync_variants",
  "nuvemshop_product_operations",
  "nuvemshop_webhook_events",
  "nuvemshop_webhook_registrations",
  "nuvemshop_ads_attempts",
  "nuvemshop_ads_submissions",
  "nuvemshop_order_billing",
  "nuvemshop_orders",
  "nuvemshop_mapping_history",
  "nuvemshop_mapping_components",
  "nuvemshop_variant_mappings",
  "nuvemshop_catalog_import_attempts",
  "nuvemshop_catalog_import_jobs",
  "nuvemshop_inventory_levels",
  "nuvemshop_locations",
  "nuvemshop_categories",
  "nuvemshop_product_images",
  "nuvemshop_variants",
  "nuvemshop_products",
  "nuvemshop_oauth_states",
  "nuvemshop_stores",
  "inventory_audit_logs",
  "inventory_outbox_events",
  "inventory_sync_proposals",
  "inventory_discrepancies",
  "inventory_reconciliation_runs",
  "inventory_quota_transfers",
  "inventory_channel_allocations",
  "inventory_allocation_policies",
  "inventory_movements",
  "inventory_reservations",
  "inventory_snapshots",
  "inventory_pools",
  "inventory_skus",
  "inventory_locations",
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
    // Linhas de configuração criadas pela migration (não são truncadas): volta ao estado inicial.
    await ctx.db.exec(`UPDATE nuvemshop_automation_settings SET mode = 'DISABLED', resume_mode = NULL, scope = 'SELECTED', policy = '{}', automatic_approved_by = NULL, automatic_approved_at = NULL, paused_reason = NULL, last_run_id = NULL, last_run_at = NULL, next_run_at = NULL, version = 1;
      UPDATE nuvemshop_emergency_stop SET active = false, reason = NULL, activated_by = NULL, activated_at = NULL;`);
    setSqlForTesting(ctx.sql);
  });
  afterAll(async () => {
    setSqlForTesting(null);
    await ctx?.db.close();
  });
  return { sql: () => ctx.sql, db: () => ctx.db };
}
