import "server-only";
import type { Sql } from "../sql";

export interface CatalogSettings {
  /** Tabela comercial de referência. null até o administrador escolher (não assumimos "G"). */
  defaultPriceTable: string | null;
  /** Filial de referência para preço. null = menor código de filial com preço ativo. */
  defaultBranchId: string | null;
}

const KEY = "catalog";

export async function getCatalogSettings(sql: Sql): Promise<CatalogSettings> {
  const rows = await sql.query<{ value: Partial<CatalogSettings> | null }>(`SELECT value FROM app_settings WHERE key = $1`, [KEY]);
  const value = rows[0]?.value ?? {};
  return {
    defaultPriceTable: typeof value.defaultPriceTable === "string" ? value.defaultPriceTable : null,
    defaultBranchId: typeof value.defaultBranchId === "string" ? value.defaultBranchId : null,
  };
}

export class SettingsValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Define a tabela de referência. Exige tabela importada e ativa (tabelas inativas não são sugeridas). */
export async function setDefaultPriceTable(sql: Sql, code: string, branchId: string | null | undefined): Promise<CatalogSettings> {
  const tables = await sql.query<{ inactive: boolean }>(`SELECT inactive FROM price_tables WHERE code = $1`, [code]);
  if (!tables.length) throw new SettingsValidationError("unknown_price_table", `Tabela ${code} não encontrada. Importe as tabelas comerciais primeiro.`);
  if (tables[0].inactive) throw new SettingsValidationError("inactive_price_table", `Tabela ${code} está inativa na ADS.`);

  const current = await getCatalogSettings(sql);
  const next: CatalogSettings = {
    defaultPriceTable: code,
    defaultBranchId: branchId === undefined ? current.defaultBranchId : branchId,
  };
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}

export interface PriceTableSummary {
  code: string;
  description: string;
  base: string | null;
  expense: string | null;
  commission: string | null;
  profit: string | null;
  freight: string | null;
  markup: string | null;
  isNormal: boolean;
  inactive: boolean;
  adsUpdatedAt: Date | null;
  updatedAt: Date;
  activePrices: number;
}

export async function listPriceTables(sql: Sql): Promise<PriceTableSummary[]> {
  return sql.query<PriceTableSummary>(
    `SELECT t.code, t.description, t.base, t.expense::text AS expense, t.commission::text AS commission, t.profit::text AS profit,
            t.freight::text AS freight, t.markup::text AS markup, t.is_normal AS "isNormal", t.inactive,
            t.ads_updated_at AS "adsUpdatedAt", t.updated_at AS "updatedAt",
            (SELECT count(*)::int FROM product_prices pp WHERE pp.price_table_code = t.code AND NOT pp.inactive) AS "activePrices"
     FROM price_tables t ORDER BY t.code`,
  );
}

export async function listBranches(sql: Sql): Promise<string[]> {
  const rows = await sql.query<{ branch_id: string }>(
    `SELECT branch_id FROM product_prices UNION SELECT branch_id FROM product_stocks ORDER BY 1`,
  );
  return rows.map((r) => r.branch_id);
}
