import "server-only";
import { sanitize } from "../logger";
import { MeliHttpError, meliRequest } from "../meli/api";
import { withReadRetry } from "../marketplace/errors";
import type { MlItem } from "./legacy";

/**
 * Modelo de estoque de um "pool" (o estoque que o Mercado Livre controla de fato):
 *   CLASSIC            — anúncio sem variações nem User Product: PUT /items/{id} { available_quantity }.
 *   CLASSIC_VARIATION  — variação de anúncio clássico: PUT /items/{id} { variations: [...] } (todas as variações
 *                        são enviadas, só a alvo com quantidade — omitir uma variação a excluiria).
 *   UP_SHARED_ITEM     — User Product sem estoque distribuído: o ML sincroniza o estoque entre os anúncios do
 *                        mesmo user_product_id; atualiza-se um deles via PUT /items/{id}.
 *   UP_SELLING_ADDRESS — estoque distribuído com localização selling_address, em site que aceita escrita nela (MLA/MLC):
 *                        PUT /user-products/{id}/stock/type/selling_address { quantity } com cabeçalho x-version.
 *   UP_SELLING_ITEM    — selling_address em site que bloqueia essa escrita (MLB: "the site is blocked for
 *                        modifications to the selling address"): o estoque é gravado pelo anúncio, PUT /items/{id}
 *                        (available_quantity ou variações), e conferido depois no estoque do User Product.
 *   MULTI_WAREHOUSE    — localizações seller_warehouse: exige mapeamento depósito ↔ filial (não suportado → não elegível).
 *   FULFILLMENT        — Full / meli_facility: estoque do ML, nunca atualizado como se fosse estoque físico da ADS.
 */
export type StockModel = "CLASSIC" | "CLASSIC_VARIATION" | "UP_SHARED_ITEM" | "UP_SELLING_ADDRESS" | "UP_SELLING_ITEM" | "MULTI_WAREHOUSE" | "FULFILLMENT" | "UNKNOWN";

/** Sites em que o vendedor pode gravar a localização selling_address pela API de User Products. */
const SELLING_ADDRESS_WRITABLE_SITES = new Set(["MLA", "MLC"]);

export interface PoolRef {
  key: string;
  itemIds: string[];
  /** '' quando o pool não é uma variação. */
  variationId: string;
  userProductId: string | null;
}

export interface RemoteItem {
  itemId: string;
  status: string | null;
  subStatus: string[];
  availableQuantity: number | null;
  logisticType: string | null;
  variationIds: string[];
  variationQuantity: number | null;
  found: boolean;
}

export interface RemoteState {
  model: StockModel;
  /** Quantidade atual do estoque controlado (o valor que será substituído). */
  quantity: number | null;
  /** x-version do estoque de User Products. */
  version: string | null;
  items: RemoteItem[];
  locations: { type: string; quantity: number | null; storeId?: string | null }[] | null;
  /** O estoque pode ser escrito pelo integrador? */
  writable: boolean;
  /** Algum anúncio do pool está pausado por outro motivo que não falta de estoque. */
  manualPause: boolean;
  reasonCode: string | null;
  reason: string | null;
}

const ITEM_FIELDS = "id,status,sub_status,available_quantity,variations,user_product_id,shipping,last_updated";

function toRemote(item: MlItem | null, itemId: string, variationId: string): RemoteItem {
  if (!item) return { itemId, status: "not_found", subStatus: [], availableQuantity: null, logisticType: null, variationIds: [], variationQuantity: null, found: false };
  const variations = Array.isArray(item.variations) ? item.variations : [];
  const v = variationId ? variations.find((x) => String(x.id) === variationId) : undefined;
  return {
    itemId,
    status: item.status ?? null,
    subStatus: Array.isArray(item.sub_status) ? item.sub_status.map(String) : [],
    availableQuantity: typeof item.available_quantity === "number" ? item.available_quantity : null,
    logisticType: item.shipping?.logistic_type ?? null,
    variationIds: variations.map((x) => String(x.id)),
    variationQuantity: v && typeof v.available_quantity === "number" ? v.available_quantity : null,
    found: true,
  };
}

async function readItems(ids: string[], variationId: string): Promise<RemoteItem[]> {
  const out: RemoteItem[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const { data } = await withReadRetry(() => meliRequest<{ code: number; body: MlItem }[]>("/items", { auth: true, query: { ids: chunk.join(","), attributes: ITEM_FIELDS } }));
    const byId = new Map<string, MlItem>();
    for (const e of Array.isArray(data) ? data : []) if (e?.code === 200 && e.body?.id) byId.set(e.body.id, e.body);
    for (const id of chunk) out.push(toRemote(byId.get(id) ?? null, id, variationId));
  }
  return out;
}

/** Estoque distribuído de um User Product. null = recurso inexistente (conta sem multiorigem). */
async function readUpStock(upId: string): Promise<{ locations: { type: string; quantity: number | null; storeId: string | null }[]; version: string | null } | null> {
  try {
    const res = await withReadRetry(() =>
      meliRequest<{ locations?: { type?: string; quantity?: number; store_id?: string | null }[] }>(`/user-products/${encodeURIComponent(upId)}/stock`, { auth: true }),
    );
    const locations = (Array.isArray(res.data?.locations) ? res.data.locations : []).map((l) => ({
      type: String(l?.type ?? "unknown"),
      quantity: typeof l?.quantity === "number" ? l.quantity : null,
      storeId: l?.store_id ?? null,
    }));
    return { locations, version: res.headers.get("x-version") };
  } catch (err) {
    if (err instanceof MeliHttpError && err.kind === "not_found") return null;
    throw err;
  }
}

const TERMINAL = new Set(["closed", "not_found", "inactive", "under_review"]);

function ineligible(base: Omit<RemoteState, "writable" | "reasonCode" | "reason">, code: string, reason: string): RemoteState {
  return { ...base, writable: false, reasonCode: code, reason };
}

/** Lê o estado remoto do pool e identifica o modelo de estoque. Somente leitura. */
export async function readRemoteState(pool: PoolRef): Promise<RemoteState> {
  const items = await readItems(pool.itemIds, pool.variationId);
  const live = items.filter((i) => i.found && !TERMINAL.has(i.status ?? "") && !i.subStatus.includes("deleted"));
  const manualPause = live.length > 0 && live.every((i) => i.status === "paused" && !i.subStatus.includes("out_of_stock"));
  const base = { model: "UNKNOWN" as StockModel, quantity: null as number | null, version: null as string | null, items, locations: null, manualPause };
  if (!live.length) {
    const s = items.map((i) => i.status).join(", ");
    return ineligible(base, "LISTING_NOT_ACTIVE", `Anúncio encerrado, excluído, em revisão ou inexistente (${s}): não é reaberto nem atualizado`);
  }
  if (live.some((i) => i.logisticType === "fulfillment")) {
    return ineligible({ ...base, model: "FULFILLMENT" }, "FULFILLMENT", "Estoque Full (gerenciado pelo Mercado Livre): não é atualizado com o saldo da ADS");
  }
  if (pool.userProductId) {
    const up = await readUpStock(pool.userProductId);
    if (up) {
      const b = { ...base, locations: up.locations, version: up.version };
      if (up.locations.some((l) => l.type === "seller_warehouse")) {
        return ineligible({ ...b, model: "MULTI_WAREHOUSE" }, "MULTI_WAREHOUSE", "Estoque em depósitos do vendedor (multiorigem): exige mapeamento depósito ↔ filial ADS");
      }
      const selling = up.locations.filter((l) => l.type === "selling_address");
      if (!selling.length) {
        if (up.locations.some((l) => l.type === "meli_facility")) {
          return ineligible({ ...b, model: "FULFILLMENT" }, "FULFILLMENT", "Estoque somente em centro do Mercado Livre (Full)");
        }
        return ineligible(b, "NO_STOCK_LOCATION", "User Product sem localização de estoque conhecida");
      }
      const quantity = selling.reduce((a, l) => a + (l.quantity ?? 0), 0);
      if (!SELLING_ADDRESS_WRITABLE_SITES.has(pool.userProductId.slice(0, 3).toUpperCase())) {
        // MLB: selling_address não é gravável pela API de User Products; grava-se pelo anúncio.
        const target = live.find((i) => (pool.variationId ? i.variationIds.includes(pool.variationId) : true));
        if (pool.variationId && !target) {
          return ineligible({ ...b, model: "UP_SELLING_ITEM" }, "VARIATION_NOT_FOUND", "Variação não encontrada no anúncio");
        }
        if (!pool.variationId && live.some((i) => i.variationIds.length)) {
          return ineligible({ ...b, model: "UP_SELLING_ITEM" }, "VARIATION_MAPPING_REQUIRED", "Anúncio com variações: vincule cada variação");
        }
        return { ...b, model: "UP_SELLING_ITEM", quantity, writable: true, reasonCode: null, reason: null };
      }
      if (!up.version) return ineligible({ ...b, model: "UP_SELLING_ADDRESS" }, "NO_VERSION", "O Mercado Livre não devolveu x-version: atualização bloqueada");
      return { ...b, model: "UP_SELLING_ADDRESS", quantity, writable: true, reasonCode: null, reason: null };
    }
    // Sem estoque distribuído: o ML replica o estoque entre os anúncios do mesmo User Product.
    const qs = [...new Set(live.map((i) => i.availableQuantity))];
    if (qs.length !== 1 || qs[0] === null) {
      return ineligible({ ...base, model: "UP_SHARED_ITEM" }, "INCONSISTENT_REMOTE", `Anúncios do mesmo User Product com quantidades diferentes (${qs.join(", ")})`);
    }
    return { ...base, model: "UP_SHARED_ITEM", quantity: qs[0], writable: true, reasonCode: null, reason: null };
  }
  const item = live[0];
  if (pool.variationId) {
    if (!item.variationIds.includes(pool.variationId) || item.variationQuantity === null) {
      return ineligible({ ...base, model: "CLASSIC_VARIATION" }, "VARIATION_NOT_FOUND", "Variação não encontrada no anúncio");
    }
    return { ...base, model: "CLASSIC_VARIATION", quantity: item.variationQuantity, writable: true, reasonCode: null, reason: null };
  }
  if (item.variationIds.length) {
    return ineligible({ ...base, model: "CLASSIC_VARIATION" }, "VARIATION_MAPPING_REQUIRED", "Anúncio com variações: vincule cada variação");
  }
  if (item.availableQuantity === null) return ineligible({ ...base, model: "CLASSIC" }, "NO_QUANTITY", "Quantidade disponível não informada pelo ML");
  return { ...base, model: "CLASSIC", quantity: item.availableQuantity, writable: true, reasonCode: null, reason: null };
}

export interface WriteCall {
  operation: string;
  method: "PUT";
  path: string;
  body: unknown;
  headers?: Record<string, string>;
}

/** Monta a única escrita permitida neste módulo: quantidade. Nada de preço, título, imagens ou descrição. */
export function buildWrite(pool: PoolRef, state: RemoteState, target: number): WriteCall {
  if (!state.writable) throw new Error("Estoque não gravável");
  if (!Number.isInteger(target) || target < 0) throw new Error("Quantidade inválida");
  switch (state.model) {
    case "UP_SELLING_ADDRESS":
      return {
        operation: "PUT_UP_STOCK_SELLING_ADDRESS",
        method: "PUT",
        path: `/user-products/${encodeURIComponent(pool.userProductId!)}/stock/type/selling_address`,
        body: { quantity: target },
        headers: { "x-version": state.version! },
      };
    case "UP_SELLING_ITEM":
      if (!pool.variationId) {
        const item = state.items.find((i) => i.found && !TERMINAL.has(i.status ?? "") && !i.subStatus.includes("deleted"))!;
        return { operation: "PUT_ITEM_QUANTITY", method: "PUT", path: `/items/${item.itemId}`, body: { available_quantity: target } };
      }
    // falls through: variação de User Product em MLB é gravada como variação do anúncio.
    case "CLASSIC_VARIATION": {
      const item = state.items.find((i) => i.found && i.variationIds.includes(pool.variationId))!;
      return {
        operation: "PUT_ITEM_VARIATION_QUANTITY",
        method: "PUT",
        path: `/items/${item.itemId}`,
        body: { variations: item.variationIds.map((id) => (id === pool.variationId ? { id: Number(id), available_quantity: target } : { id: Number(id) })) },
      };
    }
    case "UP_SHARED_ITEM":
    case "CLASSIC": {
      const item = state.items.find((i) => i.found && !TERMINAL.has(i.status ?? "") && !i.subStatus.includes("deleted"))!;
      return { operation: "PUT_ITEM_QUANTITY", method: "PUT", path: `/items/${item.itemId}`, body: { available_quantity: target } };
    }
    default:
      throw new Error(`Modelo ${state.model} não é gravável`);
  }
}

export interface WriteResult {
  status: number | null;
  response: unknown;
  durationMs: number;
}

export async function executeWrite(call: WriteCall): Promise<WriteResult> {
  const started = Date.now();
  const res = await meliRequest(call.path, { method: call.method, auth: true, body: call.body, headers: call.headers, timeoutMs: 15_000 });
  return { status: res.status, response: sanitize(res.data), durationMs: Date.now() - started };
}
