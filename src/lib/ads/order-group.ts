import "server-only";
import { createHash } from "node:crypto";
import { logger } from "../logger";
import { MeliHttpError, meliRequest } from "../meli/api";
import { withReadRetry } from "../marketplace/errors";
import { processOrder } from "../marketplace/orders";
import type { Sql } from "../sql";

/**
 * Pedidos do Mercado Livre que vão juntos para a ADS.
 *
 * Compra pelo carrinho = um pack com vários pedidos (um por anúncio), do mesmo comprador e, em geral,
 * com um único envio. Um pack com MAIS DE UM pedido vira UM pedido na ADS (uma NF-e), com os itens de
 * todos e idExterno "P" + pack_id. O ML põe pack_id em quase todos os pedidos: pack de um pedido só
 * continua como pedido avulso ("M" + order_id), exatamente como antes.
 *
 * O pedido "principal" do pack (menor order_id) guarda os dados fiscais do comprador e o envio à ADS.
 * Antes de enviar, os pedidos do pack são conferidos no ML (GET /packs/{id}); os que ainda não
 * chegaram ao integrador são importados (somente leitura no ML). Pack incompleto não é enviado.
 */
export interface OrderGroup {
  packId: string | null;
  /** true quando o pack tem mais de um pedido (vai como um pedido só na ADS). */
  isPack: boolean;
  leadId: string;
  leadOrderId: string;
  orders: { id: string; orderId: string }[];
  memberIds: string[];
  /** Problemas que impedem o envio (pack não confirmado no ML ou incompleto). */
  issues: { code: string; message: string }[];
}

const byOrderId = (a: { orderId: string }, b: { orderId: string }) => {
  const x = BigInt(a.orderId);
  const y = BigInt(b.orderId);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** idExterno do pack (máx. 17): "P" + pack_id; hash curto se o id for longo demais. */
export function externalIdForPack(packId: string): string {
  const id = `P${packId}`;
  return id.length <= 17 ? id : `P${createHash("sha256").update(packId).digest("hex").slice(0, 16).toUpperCase()}`;
}

/** Identificador externo estável (máx. 17): "M" + order_id do ML; hash curto se o id for longo demais. */
export function externalIdFor(orderId: string): string {
  const id = `M${orderId}`;
  return id.length <= 17 ? id : `M${createHash("sha256").update(orderId).digest("hex").slice(0, 16).toUpperCase()}`;
}

export function externalIdForGroup(g: OrderGroup): string {
  return g.isPack && g.packId ? externalIdForPack(g.packId) : externalIdFor(g.leadOrderId);
}

async function inboxMembers(sql: Sql, packId: string): Promise<{ id: string; orderId: string }[]> {
  const rows = await sql.query<{ id: string; orderId: string }>(
    `SELECT id::text AS id, marketplace_order_id AS "orderId" FROM marketplace_order_inbox WHERE pack_id = $1::text`,
    [packId],
  );
  return rows.filter((r) => /^\d{1,19}$/.test(r.orderId)).sort(byOrderId);
}

function group(packId: string | null, orders: { id: string; orderId: string }[], issues: OrderGroup["issues"]): OrderGroup {
  const lead = orders[0];
  return { packId, isPack: orders.length > 1, leadId: lead.id, leadOrderId: lead.orderId, orders, memberIds: orders.map((o) => o.id), issues };
}

/**
 * Resolve o grupo de envio do pedido. `verify` (padrão) confere os pedidos do pack no ML e importa os
 * que faltam; sem `verify`, usa só o que já está no integrador (consultas e conciliação).
 */
export async function resolveOrderGroup(sql: Sql, orderInboxId: string, opts: { verify?: boolean } = {}): Promise<OrderGroup> {
  const [o] = await sql.query<{ id: string; orderId: string; packId: string | null }>(
    `SELECT id::text AS id, marketplace_order_id AS "orderId", pack_id AS "packId" FROM marketplace_order_inbox WHERE id = $1::bigint`,
    [orderInboxId],
  );
  if (!o) throw new Error("Pedido não encontrado");
  if (!o.packId) return group(null, [{ id: o.id, orderId: o.orderId }], []);
  const packId = o.packId;
  let members = await inboxMembers(sql, packId);
  if (!members.length) members = [{ id: o.id, orderId: o.orderId }];
  if (opts.verify === false) return group(packId, members, []);

  const issues: OrderGroup["issues"] = [];
  let mlIds: string[] | null = null;
  try {
    const r = await withReadRetry(() => meliRequest<{ orders?: { id?: number | string }[] }>(`/packs/${encodeURIComponent(packId)}`, { auth: true }));
    mlIds = (r.data?.orders ?? []).map((x) => String(x?.id ?? "")).filter((x) => /^\d{1,19}$/.test(x));
    if (!mlIds.length) issues.push({ code: "pack_unverified", message: `O Mercado Livre não informou os pedidos do pack ${packId}; tente validar de novo` });
  } catch (err) {
    // Pack inexistente no ML e só este pedido no integrador: nada indica outros pedidos.
    const lone = err instanceof MeliHttpError && err.kind === "not_found" && members.length === 1;
    if (!lone) issues.push({ code: "pack_unverified", message: `Não foi possível confirmar no Mercado Livre os pedidos do pack ${packId} (${err instanceof Error ? err.message : "erro"}); tente validar de novo` });
  }

  if (mlIds?.length) {
    const missing = mlIds.filter((id) => !members.some((m) => m.orderId === id));
    for (const id of missing) {
      try {
        await processOrder(sql, id);
      } catch (err) {
        logger.warn("Pedido do pack não importado", { packId, orderId: id, error: err instanceof Error ? err.message : "erro" });
      }
    }
    if (missing.length) members = await inboxMembers(sql, packId);
    const still = mlIds.filter((id) => !members.some((m) => m.orderId === id));
    if (still.length) issues.push({ code: "pack_incomplete", message: `Pack ${packId}: pedido(s) ${still.join(", ")} ainda não chegaram ao integrador; use "Reler no Mercado Livre" e valide de novo` });
    const extra = members.filter((m) => !mlIds!.includes(m.orderId));
    if (extra.length) issues.push({ code: "pack_mismatch", message: `Pack ${packId}: pedido(s) ${extra.map((m) => m.orderId).join(", ")} não constam no pack segundo o Mercado Livre` });
  }
  return group(packId, members, issues);
}
