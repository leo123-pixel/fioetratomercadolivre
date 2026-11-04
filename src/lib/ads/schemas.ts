import "server-only";
import { z } from "zod";

/**
 * Validação dos itens recebidos da ADS e conversão para linhas do banco.
 *
 * Regras:
 * - produtoId é o identificador de origem; codFab não é tratado como chave.
 * - Strings vazias viram null (ausência), números são preservados como recebidos (inclusive 0).
 * - Valores monetários viram strings decimais antes de ir ao PostgreSQL (NUMERIC), sem aritmética em float.
 * - O JSON original é preservado em raw_payload.
 */

const optStr = z.string().nullish();
const optNum = z.number().nullish();
const optBool = z.boolean().nullish();

export const adsProductSchema = z.looseObject({
  produtoId: z.number().int().positive(),
  descricao: optStr,
  fornecId: z.number().int().nullish(),
  divisaoId: optStr,
  codFab: optStr,
  dun14: optStr,
  ean13: optStr,
  ncm: optStr,
  apresentacao: optStr,
  unidade: optStr,
  qtdEmb: z.number().int().nullish(),
  largura: optNum,
  altura: optNum,
  comprimento: optNum,
  pesoBruto: optNum,
  pesoLiquido: optNum,
  inativo: optBool,
  b2B: optBool,
  imagem: optStr,
  dataHora: optStr,
});

export const adsPriceTableSchema = z.looseObject({
  codigo: z.string().trim().min(1),
  descricao: optStr,
  base: optStr,
  despesa: optNum,
  comissao: optNum,
  lucro: optNum,
  frete: optNum,
  majoracao: optNum,
  normal: optBool,
  inativo: optBool,
  dataHora: optStr,
});

export const adsPriceSchema = z.looseObject({
  filialId: z.string().trim().min(1),
  tabelaPreco: z.string().trim().min(1),
  produtoId: z.number().int().positive(),
  preco: optNum,
  desconto: optNum,
  comissao: optNum,
  cTeto: optNum,
  pvs: optNum,
  quantidadeMinima: optNum,
  inativo: optBool,
  promocao: optBool,
  dataHora: optStr,
});

export const adsStockSchema = z.looseObject({
  filialId: z.string().trim().min(1),
  produtoId: z.number().int().positive(),
  // Obrigatório: um saldo ausente NÃO pode ser convertido em zero.
  estoque: z.number(),
  ultVnd: optStr,
});

export const adsSupplierSchema = z.looseObject({
  fornecId: z.number().int(),
  nome: optStr,
  fantasia: optStr,
  inativo: optBool,
});

export const adsDivisionSchema = z.looseObject({
  codigo: z.string().trim().min(1),
  descricao: optStr,
  inativo: optBool,
});

/** "" / espaços → null. Nunca inventa valor. */
export function emptyToNull(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Converte número JSON em string decimal exata para NUMERIC (sem notação exponencial). */
export function toDecimalString(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(12).replace(/\.?0+$/, "");
}

/**
 * Datas da ADS chegam sem fuso (ex.: 2026-10-22T00:00:00). Interpretadas como horário de Brasília
 * (UTC-03:00, sem horário de verão desde 2019). Retorna ISO 8601 ou null.
 */
export function parseAdsDate(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}-03:00`;
  const time = Date.parse(withZone);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export interface ItemError {
  externalProductId: number | null;
  code: string;
  message: string;
}

export type Mapped<T> = { rows: T[]; errors: ItemError[] };

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(item)"}: ${i.message}`)
    .join("; ");
}

function externalId(item: unknown): number | null {
  const id = (item as { produtoId?: unknown } | null)?.produtoId;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

function mapAll<S extends z.ZodType, T>(items: unknown[], schema: S, map: (v: z.infer<S>, raw: unknown) => T): Mapped<T> {
  const rows: T[] = [];
  const errors: ItemError[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) rows.push(map(parsed.data, item));
    else errors.push({ externalProductId: externalId(item), code: "INVALID_ITEM", message: describeIssues(parsed.error) });
  }
  return { rows, errors };
}

export interface ProductRow {
  ads_product_id: number;
  name_original: string;
  manufacturer_code: string | null;
  ean: string | null;
  dun14: string | null;
  ncm: string | null;
  supplier_id: number | null;
  division_id: string | null;
  presentation: string | null;
  unit: string | null;
  package_qty: number | null;
  gross_weight: string | null;
  net_weight: string | null;
  width: string | null;
  height: string | null;
  length: string | null;
  inactive: boolean;
  b2b: boolean | null;
  erp_image_ref: string | null;
  ads_updated_at: string | null;
  raw_payload: unknown;
}

export function mapProducts(items: unknown[]): Mapped<ProductRow> {
  return mapAll(items, adsProductSchema, (p, raw) => ({
    ads_product_id: p.produtoId,
    name_original: p.descricao?.trim() ?? "",
    manufacturer_code: emptyToNull(p.codFab),
    ean: emptyToNull(p.ean13),
    dun14: emptyToNull(p.dun14),
    ncm: emptyToNull(p.ncm),
    supplier_id: p.fornecId ?? null,
    division_id: emptyToNull(p.divisaoId),
    presentation: emptyToNull(p.apresentacao),
    unit: emptyToNull(p.unidade),
    package_qty: p.qtdEmb ?? null,
    gross_weight: toDecimalString(p.pesoBruto),
    net_weight: toDecimalString(p.pesoLiquido),
    width: toDecimalString(p.largura),
    height: toDecimalString(p.altura),
    length: toDecimalString(p.comprimento),
    inactive: p.inativo === true,
    b2b: p.b2B ?? null,
    erp_image_ref: emptyToNull(p.imagem),
    ads_updated_at: parseAdsDate(p.dataHora),
    raw_payload: raw,
  }));
}

export interface PriceTableRow {
  code: string;
  description: string;
  base: string | null;
  expense: string | null;
  commission: string | null;
  profit: string | null;
  freight: string | null;
  markup: string | null;
  is_normal: boolean;
  inactive: boolean;
  ads_updated_at: string | null;
  raw_payload: unknown;
}

export function mapPriceTables(items: unknown[]): Mapped<PriceTableRow> {
  return mapAll(items, adsPriceTableSchema, (t, raw) => ({
    code: t.codigo.trim(),
    description: t.descricao?.trim() ?? "",
    base: emptyToNull(t.base),
    expense: toDecimalString(t.despesa),
    commission: toDecimalString(t.comissao),
    profit: toDecimalString(t.lucro),
    freight: toDecimalString(t.frete),
    markup: toDecimalString(t.majoracao),
    is_normal: t.normal === true,
    inactive: t.inativo === true,
    ads_updated_at: parseAdsDate(t.dataHora),
    raw_payload: raw,
  }));
}

export interface PriceRow {
  ads_product_id: number;
  branch_id: string;
  price_table_code: string;
  price: string | null;
  discount: string | null;
  commission: string | null;
  ceiling_value: string | null;
  pvs: string | null;
  minimum_quantity: string | null;
  inactive: boolean;
  promotion: boolean;
  ads_updated_at: string | null;
  raw_payload: unknown;
}

export function mapPrices(items: unknown[]): Mapped<PriceRow> {
  return mapAll(items, adsPriceSchema, (p, raw) => ({
    ads_product_id: p.produtoId,
    branch_id: p.filialId.trim(),
    price_table_code: p.tabelaPreco.trim(),
    price: toDecimalString(p.preco),
    discount: toDecimalString(p.desconto),
    commission: toDecimalString(p.comissao),
    ceiling_value: toDecimalString(p.cTeto),
    pvs: toDecimalString(p.pvs),
    minimum_quantity: toDecimalString(p.quantidadeMinima),
    inactive: p.inativo === true,
    promotion: p.promocao === true,
    ads_updated_at: parseAdsDate(p.dataHora),
    raw_payload: raw,
  }));
}

export interface StockRow {
  ads_product_id: number;
  branch_id: string;
  quantity: string;
  last_sale_at: string | null;
  raw_payload: unknown;
}

export function mapStocks(items: unknown[]): Mapped<StockRow> {
  return mapAll(items, adsStockSchema, (s, raw) => ({
    ads_product_id: s.produtoId,
    branch_id: s.filialId.trim(),
    quantity: toDecimalString(s.estoque)!,
    last_sale_at: parseAdsDate(s.ultVnd),
    raw_payload: raw,
  }));
}

export interface SupplierRow {
  id: number;
  name: string;
  trade_name: string | null;
  inactive: boolean;
}

export function mapSuppliers(items: unknown[]): Mapped<SupplierRow> {
  return mapAll(items, adsSupplierSchema, (s) => ({
    id: s.fornecId,
    name: s.nome?.trim() ?? "",
    trade_name: emptyToNull(s.fantasia),
    inactive: s.inativo === true,
  }));
}

export interface DivisionRow {
  code: string;
  description: string;
  inactive: boolean;
}

export function mapDivisions(items: unknown[]): Mapped<DivisionRow> {
  return mapAll(items, adsDivisionSchema, (d) => ({
    code: d.codigo.trim(),
    description: d.descricao?.trim() ?? "",
    inactive: d.inativo === true,
  }));
}
