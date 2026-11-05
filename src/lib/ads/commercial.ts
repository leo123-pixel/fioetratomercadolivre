import "server-only";
import { z } from "zod";
import type { Sql } from "../sql";
import { adsCall, AdsApiError, adsEnvironment } from "./client";
import { getAdsEnv } from "./env";

/**
 * Configuração comercial dos pedidos enviados à ADS. Os códigos vêm da própria ADS (consultados ao vivo)
 * e são validados contra ela ao salvar — nada de identificadores fictícios.
 */
export const SETTINGS_KEY = "ads_order_settings";
/** A configuração é guardada por ambiente: códigos validados na homologação não valem na produção. */
export function settingsKey(environment: string = adsEnvironment().environment): string {
  return `${SETTINGS_KEY}:${environment}`;
}

export const adsOrderSettingsSchema = z.object({
  /** Operação comercial (rota operacoes, campo codigo). */
  operacaoId: z.string().trim().min(1).max(10),
  /** Origem/canal do pedido (rota origem-pedido, campo origem_id). */
  canalId: z.string().trim().min(1).max(10),
  formaDePagamentoId: z.string().trim().min(1).max(10),
  prazoId: z.string().trim().min(1).max(10),
  representanteId: z.string().trim().max(10).nullable(),
  /** Tabela de preço do pedido (1 caractere, código das tabelas da ADS). */
  tabela: z.string().trim().length(1),
  /** Categoria de cada item (1 caractere; campo exigido pela ADS, sem descrição no contrato). */
  categoriaItem: z.string().trim().length(1),
  /** Frete: "none" = não informa (frete pago pelo vendedor/ML); "buyer_paid" = valor pago pelo comprador. */
  freightMode: z.enum(["none", "buyer_paid"]),
  /** Desconto do pedido: "none" = 0; "coupon" = cupom aplicado no pedido do ML. */
  discountMode: z.enum(["none", "coupon"]),
  /** Preço de tabela dos itens: "sale_price" = preço vendido (0% desconto); "ads_table" = preço da tabela ADS. */
  itemPriceMode: z.enum(["sale_price", "ads_table"]),
  /** Data base dos vencimentos das parcelas (conciliação financeira). */
  dueDateBase: z.enum(["payment_approved", "order_date"]),
  /** Padrões para cadastro de cliente novo na ADS. */
  customerSetorId: z.string().trim().max(10).nullable(),
  customerClasseId: z.string().trim().max(10).nullable(),
  /** Telefone de contato da LOJA usado no cadastro quando o ML não informa o do comprador (DDD + número). */
  customerDefaultPhone: z.string().trim().regex(/^\d{10,11}$/, "Telefone com DDD, só números (10 ou 11 dígitos)").nullable().optional().default(null),
  /** E-mail de contato da LOJA usado no cadastro quando o ML não informa o do comprador. */
  customerDefaultEmail: z.string().trim().email("E-mail inválido").max(120).nullable().optional().default(null),
});
export type AdsOrderSettings = z.infer<typeof adsOrderSettingsSchema>;

export async function getAdsOrderSettings(sql: Sql): Promise<AdsOrderSettings | null> {
  const [row] = await sql.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [settingsKey()]);
  const parsed = adsOrderSettingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export interface Option {
  code: string;
  label: string;
  inactive?: boolean;
  extra?: Record<string, unknown>;
}

export interface CommercialOptions {
  environment: ReturnType<typeof adsEnvironment>;
  cnpjDistribuidora: string;
  operacoes: Option[];
  origens: Option[];
  formasDePagamento: Option[];
  prazos: (Option & { parcelas: number; dias: number[] })[];
  representantes: Option[];
  classes: Option[];
  /** Setores em uso pelos clientes cadastrados na ADS (a API não tem rota de setores). */
  setores: Option[];
  /** true quando todos os clientes foram lidos (a lista de setores é completa). */
  setoresComplete: boolean;
  tabelas: Option[];
  errors: Record<string, string>;
}

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export function prazoDays(p: Record<string, unknown>): number[] {
  const n = Math.max(0, Math.min(12, Number(p.parcelas ?? 0)));
  const days: number[] = [];
  for (let i = 1; i <= n; i++) days.push(Number(p[`parcela${String(i).padStart(2, "0")}`] ?? 0));
  return days;
}

/**
 * Setores efetivamente usados pelos clientes já cadastrados na ADS (GET /clientes, paginado).
 * Só o código do setor é aproveitado; nenhum dado pessoal dos clientes é guardado ou devolvido.
 */
async function clientSectors(errors: Record<string, string>): Promise<{ options: Option[]; complete: boolean }> {
  const counts = new Map<string, number>();
  let complete = false;
  try {
    for (let page = 1; page <= 10; page++) {
      const r = await adsCall<{ items?: { setorId?: string | null; inativo?: boolean }[]; hasNext?: boolean }>("GET", "clientes", { query: { page, pageSize: 500 } });
      if (r.status !== 200 || !Array.isArray(r.data?.items)) {
        errors["clientes (setores)"] = `HTTP ${r.status}`;
        break;
      }
      for (const c of r.data.items) {
        const code = s(c.setorId);
        if (code && !c.inativo) counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      if (!r.data.hasNext) {
        complete = true;
        break;
      }
    }
  } catch (err) {
    if (err instanceof AdsApiError && err.kind === "auth") throw err;
    errors["clientes (setores)"] = err instanceof Error ? err.message : "erro";
  }
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, n]) => ({ code, label: `usado por ${n} cliente(s) ativo(s)` }));
  return { options, complete };
}

/** Consulta as listas reais da ADS. Representantes: só código, nome e situação (a rota devolve usuário/senha). */
export async function fetchCommercialOptions(sql: Sql): Promise<CommercialOptions> {
  const env = getAdsEnv();
  const errors: Record<string, string> = {};
  async function list(resource: string, query?: Record<string, string>): Promise<Record<string, unknown>[]> {
    try {
      const r = await adsCall<unknown>("GET", resource, { query });
      if (r.status !== 200 || !Array.isArray(r.data)) {
        errors[resource] = `HTTP ${r.status}`;
        return [];
      }
      return r.data as Record<string, unknown>[];
    } catch (err) {
      if (err instanceof AdsApiError && err.kind === "auth") throw err;
      errors[resource] = err instanceof Error ? err.message : "erro";
      return [];
    }
  }
  // A rota tem o filtro opcional "mobile"; sem ele a ADS pode devolver só parte das operações.
  // Consulta as três variações e junta por código (sem duplicar).
  const operacoes: Record<string, unknown>[] = [];
  const seenOps = new Set<string>();
  for (const q of [undefined, { mobile: "false" }, { mobile: "true" }]) {
    for (const o of await list("operacoes", q)) {
      const code = s(o.codigo);
      if (code && !seenOps.has(code)) {
        seenOps.add(code);
        operacoes.push(o);
      }
    }
  }
  operacoes.sort((a, b) => s(a.codigo).localeCompare(s(b.codigo), "pt-BR", { numeric: true }));
  const origens = await list("origem-pedido");
  const formas = await list("formas-de-pagamento");
  const prazos = await list("prazos");
  const representantes = await list("representantes");
  const classes = await list("classes");
  const setores = await clientSectors(errors);
  const tabelas = await sql.query<{ code: string; description: string; inactive: boolean }>(
    `SELECT code, description, inactive FROM price_tables WHERE char_length(code) = 1 ORDER BY code`,
  );
  return {
    environment: adsEnvironment(env),
    cnpjDistribuidora: env.cnpj,
    operacoes: operacoes.map((o) => ({ code: s(o.codigo), label: s(o.descricao), inactive: o.inativo === true, extra: { tipo: s(o.tipo), modo: s(o.modo), movimentaEstoque: o.movimentaEstoque === true, orcamento: o.orcamento === true } })),
    origens: origens.map((o) => ({ code: s(o.origem_id), label: s(o.descricao) })),
    formasDePagamento: formas.map((f) => ({ code: s(f.codigo), label: s(f.descricao), inactive: f.inativo === true, extra: { boleto: f.boleto === true, cartaoCredito: f.cartaoCredito === true, prazoId: s(f.prazoId) } })),
    prazos: prazos.map((p) => ({ code: s(p.codigo), label: s(p.descricao), inactive: p.inativo === true, parcelas: Number(p.parcelas ?? 0), dias: prazoDays(p) })),
    representantes: representantes.map((r) => ({ code: s(r.codigo), label: s(r.nome), inactive: r.inativo === true })),
    classes: classes.map((c) => ({ code: s(c.classeId), label: s(c.descricao), inactive: c.inativo === true })),
    setores: setores.options,
    setoresComplete: setores.complete,
    tabelas: tabelas.map((t) => ({ code: t.code, label: t.description, inactive: t.inactive })),
    errors,
  };
}

export class SettingsError extends Error {
  constructor(
    readonly issues: { field: string; message: string }[],
  ) {
    super("Configuração inválida");
    this.name = "SettingsError";
  }
}

/** Valida cada código contra as listas reais da ADS (ativo e existente) e grava. */
export async function saveAdsOrderSettings(sql: Sql, input: unknown): Promise<AdsOrderSettings> {
  const parsed = adsOrderSettingsSchema.safeParse(input);
  if (!parsed.success) throw new SettingsError(parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  const v = parsed.data;
  const o = await fetchCommercialOptions(sql);
  const issues: { field: string; message: string }[] = [];
  const check = (field: keyof AdsOrderSettings, value: string | null, list: Option[], source: string, required = true) => {
    if (!value) {
      if (required) issues.push({ field, message: "Obrigatório" });
      return;
    }
    if (o.errors[source]) return issues.push({ field, message: `Não foi possível consultar ${source} na ADS (${o.errors[source]})` });
    const found = list.find((x) => x.code === value);
    if (!found) issues.push({ field, message: `Código ${value} não existe em ${source} na ADS` });
    else if (found.inactive) issues.push({ field, message: `Código ${value} está inativo na ADS` });
  };
  check("operacaoId", v.operacaoId, o.operacoes, "operacoes");
  check("canalId", v.canalId, o.origens, "origem-pedido");
  check("formaDePagamentoId", v.formaDePagamentoId, o.formasDePagamento, "formas-de-pagamento");
  check("prazoId", v.prazoId, o.prazos, "prazos");
  check("representanteId", v.representanteId, o.representantes, "representantes", false);
  check("customerClasseId", v.customerClasseId, o.classes, "classes", false);
  // Setor: sem rota própria na API; quando todos os clientes foram lidos, o código precisa estar em uso.
  if (v.customerSetorId && o.setoresComplete && o.setores.length && !o.setores.some((x) => x.code === v.customerSetorId)) {
    issues.push({ field: "customerSetorId", message: `Setor ${v.customerSetorId} não é usado por nenhum cliente desta ADS (provavelmente não existe neste ambiente)` });
  }
  if (!o.tabelas.some((t) => t.code === v.tabela && !t.inactive)) issues.push({ field: "tabela", message: `Tabela ${v.tabela} não existe ou está inativa (tabelas importadas da ADS)` });
  if (issues.length) throw new SettingsError(issues);
  await sql.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [settingsKey(o.environment.environment), JSON.stringify(v)],
  );
  return v;
}
