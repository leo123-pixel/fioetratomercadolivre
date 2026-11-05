import "server-only";
import { MeliHttpError, meliRequest } from "../meli/api";
import type { Sql } from "../sql";
import { withReadRetry } from "./errors";

/**
 * Dados fiscais do comprador (somente leitura). Fluxo atual do ML: billing_info.id no pedido
 * (buyer.billing_info.id) → GET /orders/billing-info/MLB/{billing_info_id}. O endpoint legado
 * /orders/{id}/billing_info foi depreciado e só é tentado se o pedido não trouxer o id.
 * Nada é inventado: campos ausentes ficam registrados em "missing".
 */
export interface BillingAddress {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface BillingData {
  billingInfoId: string | null;
  docType: "CPF" | "CNPJ" | null;
  docNumber: string | null;
  name: string | null;
  stateRegistration: string | null;
  taxpayerType: string | null;
  address: BillingAddress;
}

const str = (v: unknown, max = 200): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(typeof v === "object" ? ((v as { name?: unknown; code?: unknown; description?: unknown }).code ?? (v as { name?: unknown }).name ?? (v as { description?: unknown }).description ?? "") : v).trim();
  return t ? t.slice(0, max) : null;
};
const digits = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/\D/g, ""));

function cpfValid(c: string): boolean {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

function cnpjValid(c: string): boolean {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, wi, i) => acc + wi * Number(c[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export function validDocument(doc: string | null): boolean {
  if (!doc) return false;
  return doc.length === 11 ? cpfValid(doc) : doc.length === 14 ? cnpjValid(doc) : false;
}

/** Interpreta a resposta do novo endpoint (buyer.billing_info) e a do legado (billing_info + additional_info). */
export function parseBillingInfo(body: unknown, billingInfoId: string | null): BillingData {
  const root = (body ?? {}) as Record<string, unknown>;
  const buyer = (root.buyer ?? {}) as Record<string, unknown>;
  const bi = (buyer.billing_info ?? root.billing_info ?? root) as Record<string, unknown>;
  const extra: Record<string, string> = {};
  if (Array.isArray(bi.additional_info)) {
    for (const a of bi.additional_info as { type?: string; value?: unknown }[]) if (a?.type) extra[a.type.toUpperCase()] = String(a.value ?? "");
  }
  const ident = (bi.identification ?? {}) as Record<string, unknown>;
  const rawType = str(ident.type ?? bi.doc_type)?.toUpperCase() ?? null;
  const doc = digits(ident.number ?? bi.doc_number);
  const docType = rawType === "CPF" || rawType === "CNPJ" ? rawType : doc.length === 11 ? "CPF" : doc.length === 14 ? "CNPJ" : null;
  const addr = (bi.address ?? {}) as Record<string, unknown>;
  const taxes = (bi.taxes ?? {}) as Record<string, unknown>;
  const inscriptions = (taxes.inscriptions ?? {}) as Record<string, unknown>;
  const business = str(bi.business_name ?? extra.BUSINESS_NAME, 150);
  const person = [str(bi.name ?? extra.FIRST_NAME, 100), str(bi.last_name ?? extra.LAST_NAME, 100)].filter(Boolean).join(" ") || null;
  return {
    billingInfoId,
    docType,
    docNumber: doc || null,
    name: docType === "CNPJ" ? (business ?? person) : (person ?? business),
    stateRegistration: str(inscriptions.state_registration ?? extra.STATE_REGISTRATION, 30),
    taxpayerType: str(taxes.taxpayer_type ?? extra.TAXPAYER_TYPE_ID, 60),
    address: {
      street: str(addr.street_name ?? extra.STREET_NAME, 100),
      number: str(addr.street_number ?? extra.STREET_NUMBER, 10),
      complement: str(addr.comment ?? addr.complement ?? extra.COMMENT, 60),
      neighborhood: str(addr.neighborhood ?? extra.NEIGHBORHOOD, 60),
      city: str(addr.city_name ?? addr.city ?? extra.CITY_NAME, 80),
      state: str(addr.state_code ?? addr.state ?? extra.STATE_CODE ?? extra.STATE_NAME, 30)?.replace(/^BR-/, "") ?? null,
      zip: digits(addr.zip_code ?? extra.ZIP_CODE) || null,
    },
  };
}

/** Campos necessários para identificar o cliente e, se preciso, cadastrá-lo na ADS. */
export function missingBillingFields(b: BillingData): string[] {
  const m: string[] = [];
  if (!b.docType || !b.docNumber) m.push("documento");
  else if (!validDocument(b.docNumber)) m.push("documento_invalido");
  if (!b.name) m.push("nome");
  if (!b.address.street) m.push("endereco.rua");
  if (!b.address.number) m.push("endereco.numero");
  if (!b.address.neighborhood) m.push("endereco.bairro");
  if (!b.address.city) m.push("endereco.cidade");
  if (!b.address.state || !/^[A-Z]{2}$/.test(b.address.state)) m.push("endereco.uf");
  if (!b.address.zip || b.address.zip.length !== 8) m.push("endereco.cep");
  return m;
}

export interface StoredBilling extends BillingData {
  status: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";
  missing: string[];
  fetchedAt: Date;
}

/** Consulta os dados fiscais no ML e grava (substituindo a leitura anterior). */
export async function fetchOrderBilling(sql: Sql, orderInboxId: string): Promise<StoredBilling> {
  const [o] = await sql.query<{ orderId: string; raw: Record<string, unknown> | null }>(
    `SELECT o.marketplace_order_id AS "orderId", r.payload AS raw FROM marketplace_order_inbox o
     LEFT JOIN marketplace_order_raw r ON r.order_id = o.id WHERE o.id = $1::bigint`,
    [orderInboxId],
  );
  if (!o) throw new Error("Pedido não encontrado");
  let raw = o.raw;
  if (!raw) raw = (await withReadRetry(() => meliRequest<Record<string, unknown>>(`/orders/${o.orderId}`, { auth: true }))).data;
  const billingId = str(((raw?.buyer as Record<string, unknown> | undefined)?.billing_info as Record<string, unknown> | undefined)?.id, 40);
  let body: unknown = null;
  try {
    if (billingId && /^[A-Za-z0-9_-]{1,40}$/.test(billingId)) {
      body = (await withReadRetry(() => meliRequest(`/orders/billing-info/MLB/${billingId}`, { auth: true }))).data;
    } else {
      body = (await withReadRetry(() => meliRequest(`/orders/${o.orderId}/billing_info`, { auth: true }))).data;
    }
  } catch (err) {
    if (!(err instanceof MeliHttpError && (err.kind === "not_found" || err.kind === "forbidden" || err.kind === "bad_request"))) throw err;
  }
  const data = body ? parseBillingInfo(body, billingId) : parseBillingInfo({}, billingId);
  const missing = body ? missingBillingFields(data) : ["dados_fiscais_indisponiveis"];
  const status: StoredBilling["status"] = !body ? "UNAVAILABLE" : missing.length ? "INCOMPLETE" : "COMPLETE";
  await sql.execute(
    `INSERT INTO marketplace_order_billing (order_id, billing_info_id, status, doc_type, doc_number, name, state_registration, taxpayer_type, address, missing, fetched_at)
     VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::jsonb, $10::jsonb, now())
     ON CONFLICT (order_id) DO UPDATE SET billing_info_id = EXCLUDED.billing_info_id, status = EXCLUDED.status, doc_type = EXCLUDED.doc_type,
       doc_number = EXCLUDED.doc_number, name = EXCLUDED.name, state_registration = EXCLUDED.state_registration,
       taxpayer_type = EXCLUDED.taxpayer_type, address = EXCLUDED.address, missing = EXCLUDED.missing, fetched_at = now()`,
    [orderInboxId, billingId, status, data.docType, data.docNumber, data.name, data.stateRegistration, data.taxpayerType, JSON.stringify(data.address), JSON.stringify(missing)],
  );
  return { ...data, status, missing, fetchedAt: new Date() };
}

export async function getOrderBilling(sql: Sql, orderInboxId: string): Promise<StoredBilling | null> {
  const [b] = await sql.query<Record<string, unknown>>(
    `SELECT billing_info_id AS "billingInfoId", status, doc_type AS "docType", doc_number AS "docNumber", name,
            state_registration AS "stateRegistration", taxpayer_type AS "taxpayerType", address, missing, fetched_at AS "fetchedAt"
     FROM marketplace_order_billing WHERE order_id = $1::bigint`,
    [orderInboxId],
  );
  return (b as unknown as StoredBilling) ?? null;
}

/** CPF/CNPJ mascarado para telas e logs: 123.***.***-09. */
export function maskDocument(doc: string | null): string | null {
  if (!doc) return null;
  return doc.length <= 5 ? "***" : `${doc.slice(0, 3)}${"*".repeat(doc.length - 5)}${doc.slice(-2)}`;
}
