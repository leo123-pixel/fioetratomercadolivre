import "server-only";
import { logger, redactString } from "../logger";
import { getOrderBilling, maskDocument, setOrderBillingCity, type CityIbgeSource, type StoredBilling } from "../marketplace/billing";
import type { Sql } from "../sql";
import { adsCall, AdsApiError, adsEnvironment, adsProblem, assertAdsWriteAllowed } from "./client";
import type { AdsOrderSettings } from "./commercial";
import { municipioByCep, municipioByCode, municipioByName, normCity } from "./ibge";

/**
 * Cliente da ADS identificado pelo CPF/CNPJ dos dados fiscais do pedido.
 * - Consulta GET /clientes?cnpjcpf=... (somente leitura) e grava o vínculo em ads_customers.
 * - Sem cliente: monta o cadastro (POST /clientes) para aprovação manual; nada é inventado — campo
 *   ausente bloqueia o cadastro. Antes de cadastrar, consulta de novo (evita duplicidade).
 * - Tudo é separado por ambiente (homologação × produção): o clienteId de um não vale no outro.
 * - O cadastro exige confirmação explícita do administrador e escrita liberada no ambiente.
 */
export type CustomerStatus = "FOUND" | "NOT_FOUND" | "AMBIGUOUS" | "CREATING" | "CREATED" | "UNKNOWN" | "ERROR";

export interface AdsCustomer {
  cnpjCpf: string;
  adsClienteId: number | null;
  status: CustomerStatus;
  draft: unknown;
  lastError: string | null;
  checkedAt: Date | null;
}

async function logAttempt(sql: Sql, orderInboxId: string | null, a: { operation: string; status?: number | null; request?: unknown; response?: unknown; error?: string | null; durationMs?: number | null }) {
  await sql.execute(
    `INSERT INTO ads_order_attempts (order_id, operation, http_status, request, response, error, duration_ms, environment)
     VALUES ($1::bigint, $2::text, $3::int, $4::jsonb, $5::jsonb, $6::text, $7::int, $8::text)`,
    [orderInboxId, a.operation, a.status ?? null, a.request === undefined ? null : JSON.stringify(a.request), a.response === undefined ? null : JSON.stringify(a.response), a.error ?? null, a.durationMs ?? null, adsEnvironment().environment],
  );
}

export async function getAdsCustomer(sql: Sql, cnpjCpf: string): Promise<AdsCustomer | null> {
  const [c] = await sql.query<AdsCustomer>(
    `SELECT cnpj_cpf AS "cnpjCpf", ads_cliente_id AS "adsClienteId", status, draft, last_error AS "lastError", checked_at AS "checkedAt"
     FROM ads_customers WHERE cnpj_cpf = $1::text AND environment = $2::text`,
    [cnpjCpf, adsEnvironment().environment],
  );
  return c ?? null;
}

async function upsertCustomer(sql: Sql, cnpjCpf: string, status: CustomerStatus, f: { adsClienteId?: number | null; draft?: unknown; lastError?: string | null; createdBy?: string | null } = {}) {
  await sql.execute(
    `INSERT INTO ads_customers (cnpj_cpf, ads_cliente_id, status, draft, last_error, created_by, checked_at, updated_at, environment)
     VALUES ($1::text, $2::int, $3::text, $4::jsonb, $5::text, $6::text, now(), now(), $7::text)
     ON CONFLICT (environment, cnpj_cpf) DO UPDATE SET ads_cliente_id = COALESCE(EXCLUDED.ads_cliente_id, ads_customers.ads_cliente_id), status = EXCLUDED.status,
       draft = COALESCE(EXCLUDED.draft, ads_customers.draft), last_error = EXCLUDED.last_error,
       created_by = COALESCE(EXCLUDED.created_by, ads_customers.created_by), checked_at = now(), updated_at = now()`,
    [cnpjCpf, f.adsClienteId ?? null, status, f.draft === undefined ? null : JSON.stringify(f.draft), f.lastError ?? null, f.createdBy ?? null, adsEnvironment().environment],
  );
}

/** Procura o cliente na ADS pelo documento (correspondência exata dos dígitos). */
export async function lookupAdsCustomer(sql: Sql, cnpjCpf: string, orderInboxId: string | null = null): Promise<AdsCustomer> {
  const doc = cnpjCpf.replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) throw new Error("CPF/CNPJ inválido");
  const r = await adsCall<{ items?: { clienteId?: number; cnpjCpf?: string; inativo?: boolean }[] }>("GET", "clientes", { query: { cnpjcpf: doc, page: 1, pageSize: 20 } });
  await logAttempt(sql, orderInboxId, { operation: "CUSTOMER_LOOKUP", status: r.status, request: { cnpjcpf: maskDocument(doc) }, response: { total: r.data?.items?.length ?? null }, durationMs: r.durationMs });
  if (r.status !== 200 || !Array.isArray(r.data?.items)) {
    await upsertCustomer(sql, doc, "ERROR", { lastError: `${r.status >= 500 || r.status === 429 ? "ADS indisponível" : "Consulta de clientes na ADS"} (HTTP ${r.status})${adsProblem(r.data) ? `: ${adsProblem(r.data)}` : ""}${r.status >= 500 ? "; tente de novo em instantes" : ""}` });
    return (await getAdsCustomer(sql, doc))!;
  }
  const matches = r.data.items.filter((c) => String(c.cnpjCpf ?? "").replace(/\D/g, "") === doc && typeof c.clienteId === "number");
  const current = await getAdsCustomer(sql, doc);
  if (matches.length === 1) await upsertCustomer(sql, doc, current?.status === "CREATED" ? "CREATED" : "FOUND", { adsClienteId: matches[0].clienteId!, lastError: matches[0].inativo ? "Cliente inativo na ADS" : null });
  else if (matches.length > 1) await upsertCustomer(sql, doc, "AMBIGUOUS", { lastError: `${matches.length} clientes com o mesmo documento na ADS: resolva na ADS antes de enviar` });
  else await upsertCustomer(sql, doc, "NOT_FOUND");
  return (await getAdsCustomer(sql, doc))!;
}

export interface CustomerDraft {
  request: Record<string, unknown>;
  missing: string[];
  /** De onde veio o município (código IBGE) do endereço; null = não resolvido (escolha manual). */
  city: (ResolvedCity & { billingCity: string | null }) | null;
}

export interface ResolvedCity {
  code: string;
  name: string;
  source: CityIbgeSource;
  /** Detalhe da origem (ex.: "CEP 36909-300 via BrasilAPI"). */
  via?: string;
}

/**
 * Município (código IBGE) do endereço. Nunca adivinha:
 * 0) o que já foi resolvido/escolhido para este pedido;
 * 1) nome exato e único na lista oficial do IBGE (guardada no projeto, sem rede);
 * 2) CEP → município (Mercado Livre, BrasilAPI, ViaCEP em paralelo; código conferido na lista oficial e na UF) —
 *    resolve distritos/bairros informados como cidade (ex.: "Realeza" → Manhuaçu);
 * 3) cadastro de cidades da ADS (nome exato e único).
 * Sem resultado → null: o operador escolhe o município na tela.
 */
export async function resolveCity(billing: StoredBilling, opts: { sql?: Sql; orderInboxId?: string } = {}): Promise<ResolvedCity | null> {
  if (billing.cityIbge) return billing.cityIbge;
  const a = billing.address;
  const uf = a.state && /^[A-Z]{2}$/.test(a.state) ? a.state : null;
  if (!uf) return null;
  let found: ResolvedCity | null = null;
  const byName = municipioByName(a.city, uf);
  if (byName) found = { code: byName.code, name: byName.name, source: "NOME" };
  if (!found) {
    const byCep = await municipioByCep(a.zip, uf).catch(() => null);
    if (byCep) found = { code: byCep.code, name: byCep.name, source: "CEP", via: `CEP ${a.zip!.slice(0, 5)}-${a.zip!.slice(5)} via ${byCep.via}` };
  }
  if (!found && a.city) {
    const r = await adsCall<{ descricao?: string; uf?: string; codigoIbge?: string }[]>("GET", "cidades", { query: { uf }, timeoutMs: 8_000 }).catch(() => null);
    if (r?.status === 200 && Array.isArray(r.data)) {
      const hits = r.data.filter((c) => c.descricao && normCity(c.descricao) === normCity(a.city!) && (c.uf ?? uf).toUpperCase() === uf && /^\d{7}$/.test(String(c.codigoIbge ?? "")));
      const m = hits.length === 1 ? municipioByCode(String(hits[0].codigoIbge)) : null;
      if (m && m.uf === uf) found = { code: m.code, name: m.name, source: "ADS" };
    }
  }
  if (found && opts.sql && opts.orderInboxId) await setOrderBillingCity(opts.sql, opts.orderInboxId, found).catch(() => undefined);
  return found;
}

/** Compatibilidade: só o código IBGE pelo nome/UF (sem CEP). */
export async function resolveIbge(city: string | null, uf: string | null, zip: string | null = null): Promise<string | null> {
  const r = await resolveCity({ address: { city, state: uf, zip, street: null, number: null, complement: null, neighborhood: null } } as StoredBilling);
  return r?.code ?? null;
}

/** Operador escolhe o município (código da lista oficial, na UF do endereço). */
export async function setCustomerCity(sql: Sql, orderInboxId: string, code: string): Promise<ResolvedCity> {
  const billing = await getOrderBilling(sql, orderInboxId);
  if (!billing) throw new CustomerError("no_billing", "Consulte os dados fiscais do comprador antes");
  const m = municipioByCode(code);
  if (!m) throw new CustomerError("invalid_city", "Código IBGE inexistente na lista oficial");
  if (billing.address.state && m.uf !== billing.address.state) throw new CustomerError("invalid_city", `O município escolhido é de ${m.uf}, mas o endereço é de ${billing.address.state}`);
  const city: ResolvedCity = { code: m.code, name: m.name, source: "MANUAL" };
  await setOrderBillingCity(sql, orderInboxId, city);
  return city;
}

/** Monta o cadastro de cliente (POST /clientes) a partir dos dados fiscais. Campos ausentes vão em "missing". */
export async function buildCustomerDraft(billing: StoredBilling, settings: AdsOrderSettings | null, opts: { sql?: Sql; orderInboxId?: string } = {}): Promise<CustomerDraft> {
  const missing = [...billing.missing.filter((m) => m !== "dados_fiscais_indisponiveis")];
  if (billing.status === "UNAVAILABLE") missing.push("dados_fiscais_indisponiveis");
  if (!settings?.customerSetorId) missing.push("config.setorId");
  if (!settings?.customerClasseId) missing.push("config.classeId");
  const a = billing.address;
  // O ML normalmente não informa telefone/e-mail do comprador: usa o contato da LOJA, se configurado.
  const phone = a.phone ?? settings?.customerDefaultPhone ?? null;
  const email = a.email ?? settings?.customerDefaultEmail ?? null;
  const storeContact = !a.phone && !!settings?.customerDefaultPhone;
  if (!phone) missing.push("telefone (configure o telefone padrão da loja)");
  const city = await resolveCity(billing, opts).catch(() => null);
  const ibge = city?.code ?? null;
  if (!ibge) missing.push("endereco.codigoIbge");
  const request: Record<string, unknown> = {
    cnpjCpf: billing.docNumber,
    nome: billing.name?.slice(0, 60) ?? null,
    nomeFantasia: billing.name?.slice(0, 60) ?? null,
    setorId: settings?.customerSetorId ?? null,
    classeId: settings?.customerClasseId ?? null,
    tabela: settings?.tabela ?? null,
    prazoId: settings?.prazoId ?? null,
    formaDePagamentoId: settings?.formaDePagamentoId ?? null,
    representanteId: settings?.representanteId ?? null,
    telefone: phone,
    email,
    observacao: storeContact ? "Cliente Mercado Livre (integrador). Telefone/e-mail da loja: o ML não informa o do comprador" : "Cliente Mercado Livre (integrador)",
    endereco: { cep: a.zip, numero: a.number, rua: a.street, uf: a.state, complemento: a.complement, bairro: a.neighborhood, codigoIbge: ibge },
    contato: { nome: billing.name?.slice(0, 60) ?? null },
  };
  if (billing.docType === "CNPJ" && billing.stateRegistration) request.inscricaoEstadual = billing.stateRegistration;
  return { request, missing: [...new Set(missing)], city: city ? { ...city, billingCity: a.city } : null };
}

export class CustomerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CustomerError";
  }
}

/**
 * Cadastra o cliente na ADS de HOMOLOGAÇÃO. Exige dados completos, consulta antes (sem duplicar) e
 * trata timeout como resultado incerto (UNKNOWN), resolvido por nova consulta — sem repetir o POST.
 */
export async function createAdsCustomer(sql: Sql, orderInboxId: string, settings: AdsOrderSettings | null, by: string): Promise<AdsCustomer> {
  assertAdsWriteAllowed();
  const billing = await getOrderBilling(sql, orderInboxId);
  if (!billing?.docNumber) throw new CustomerError("no_billing", "Consulte os dados fiscais do comprador antes");
  const doc = billing.docNumber;
  const before = await lookupAdsCustomer(sql, doc, orderInboxId);
  if (before.status === "FOUND" || before.status === "CREATED") return before;
  if (before.status === "AMBIGUOUS") throw new CustomerError("ambiguous", before.lastError ?? "Cliente duplicado na ADS");
  if (before.status === "ERROR") throw new CustomerError("lookup_failed", before.lastError ?? "Não foi possível consultar a ADS");
  const draft = await buildCustomerDraft(billing, settings, { sql, orderInboxId });
  if (draft.missing.length) {
    await upsertCustomer(sql, doc, "NOT_FOUND", { draft: draft.request, lastError: `Cadastro incompleto: ${draft.missing.join(", ")}` });
    throw new CustomerError("incomplete", `Dados insuficientes para cadastrar: ${draft.missing.join(", ")}`);
  }
  const claimed = await sql.execute(
    `UPDATE ads_customers SET status = 'CREATING', draft = $2::jsonb, created_by = $3::text, updated_at = now()
     WHERE cnpj_cpf = $1::text AND status = 'NOT_FOUND' AND environment = $4::text`,
    [doc, JSON.stringify(draft.request), by, adsEnvironment().environment],
  );
  if (!claimed) throw new CustomerError("busy", "Cadastro já em andamento para este documento");
  const masked = { ...draft.request, cnpjCpf: maskDocument(doc) };
  try {
    const r = await adsCall<{ clienteId?: number }>("POST", "clientes", { body: draft.request });
    await logAttempt(sql, orderInboxId, { operation: "CUSTOMER_CREATE", status: r.status, request: masked, response: r.data, durationMs: r.durationMs });
    if (r.status === 201 && typeof r.data?.clienteId === "number") {
      await upsertCustomer(sql, doc, "CREATED", { adsClienteId: r.data.clienteId });
      // Relê o cadastro para saber a situação real (a ADS pode criar o cliente como inativo).
      await lookupAdsCustomer(sql, doc, orderInboxId).catch(() => undefined);
      logger.info("Cliente cadastrado na ADS", { orderInboxId, clienteId: r.data.clienteId, environment: adsEnvironment().environment });
    } else if (r.status >= 500) {
      await upsertCustomer(sql, doc, "UNKNOWN", { lastError: `ADS respondeu ${r.status}; confirme com nova consulta antes de tentar de novo` });
    } else {
      await upsertCustomer(sql, doc, "NOT_FOUND", { lastError: redactString(`ADS recusou o cadastro (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 500)}`) });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    await logAttempt(sql, orderInboxId, { operation: "CUSTOMER_CREATE", request: masked, error: msg });
    const uncertain = err instanceof AdsApiError && (err.kind === "timeout" || err.kind === "network");
    await upsertCustomer(sql, doc, uncertain ? "UNKNOWN" : "NOT_FOUND", { lastError: uncertain ? "Resultado incerto (timeout/rede): consulte a ADS antes de tentar de novo" : msg });
  }
  return (await getAdsCustomer(sql, doc))!;
}
