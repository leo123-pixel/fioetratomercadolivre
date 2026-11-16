import "server-only";
import type { Sql } from "../sql";
import { inventoryCoreMode } from "./mode";

/**
 * Livro de movimentações, outbox transacional, auditoria e controle de concorrência do Inventory Core.
 *
 * Concorrência (vale para várias instâncias da aplicação — nada depende de lock em memória):
 *   - withPoolLock: transação + pg_advisory_xact_lock(hashtext(pool_key)). O lock é liberado no fim da
 *     transação (compatível com o pooler do Supabase em modo transação).
 *   - versões (version) em pools, reservas, cotas e políticas: UPDATE ... WHERE version = $esperada.
 *   - chaves idempotentes únicas em movimentações, reservas, transferências e outbox: repetir um evento
 *     (webhook duplicado, worker reiniciado) não gera nada novo.
 * Nenhuma chamada externa acontece dentro dessas transações.
 */

export type MovementType =
  | "ADS_STOCK_SNAPSHOT"
  | "ORDER_RECEIVED"
  | "ORDER_RESERVED"
  | "ADS_ORDER_CREATED"
  | "ADS_ORDER_UNCERTAIN"
  | "ADS_ORDER_FAILED"
  | "ADS_ORDER_CANCELLED"
  | "ADS_STOCK_CONFIRMED"
  | "ORDER_CANCELLED"
  | "ORDER_RETURNED"
  | "STOCK_RELEASED"
  | "QUOTA_ALLOCATED"
  | "QUOTA_TRANSFER_REQUESTED"
  | "QUOTA_TRANSFER_CONFIRMED"
  | "QUOTA_TRANSFER_BLOCKED"
  | "STOCK_DISCREPANCY"
  | "STOCK_RECONCILED";

export type MovementOrigin = "ML_ORDER_INBOX" | "ADS_SUBMISSION" | "ADS_SNAPSHOT" | "INVENTORY_CORE" | "ADMIN" | "SIMULATION";

export interface MovementInput {
  type: MovementType;
  poolId?: string | null;
  productId?: number | null;
  adsProductId?: number | null;
  skuCode?: string | null;
  branchId?: string | null;
  warehouseCode?: string | null;
  channel?: string | null;
  externalOrderId?: string | null;
  reservationId?: string | null;
  quantity?: number | string | null;
  status?: "RECORDED" | "IGNORED_STALE" | "INFORMATIONAL";
  origin: MovementOrigin;
  /**
   * OBSERVED = fato externo (ex.: baixa/saldo na ADS) — o Inventory Core não é o autor da alteração física.
   * INTERNAL = decisão do Inventory Core (reserva local, cota, simulação).
   */
  responsibility: "OBSERVED" | "INTERNAL";
  occurredAt?: Date | string | null;
  correlationId: string;
  idempotencyKey: string;
  simulated?: boolean;
  details?: unknown;
}

export async function withPoolLock<T>(sql: Sql, poolKey: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.transaction(async (tx) => {
    await tx.execute(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`inventory:pool:${poolKey}`]);
    return fn(tx);
  });
}

/** Grava a movimentação uma única vez (chave idempotente). Retorna false se já existia. */
export async function recordMovement(sql: Sql, m: MovementInput): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO inventory_movements (event_type, pool_id, product_id, ads_product_id, sku_code, branch_id, warehouse_code, channel, external_order_id,
       reservation_id, quantity, status, origin, responsibility, occurred_at, correlation_id, idempotency_key, simulated, details)
     VALUES ($1::text, $2::bigint, $3::int, $4::int, $5::text, $6::text, $7::text, $8::text, $9::text, $10::bigint, $11::numeric, $12::text, $13::text,
       $14::text, COALESCE($15::timestamptz, now()), $16::text, $17::text, $18::boolean, $19::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
    [
      m.type,
      m.poolId ?? null,
      m.productId ?? null,
      m.adsProductId ?? null,
      m.skuCode ?? null,
      m.branchId ?? null,
      m.warehouseCode ?? null,
      m.channel ?? null,
      m.externalOrderId ?? null,
      m.reservationId ?? null,
      m.quantity === null || m.quantity === undefined ? null : String(m.quantity),
      m.status ?? "RECORDED",
      m.origin,
      m.responsibility,
      m.occurredAt ? new Date(m.occurredAt).toISOString() : null,
      m.correlationId,
      m.idempotencyKey,
      m.simulated ?? false,
      m.details === undefined ? null : JSON.stringify(m.details),
    ],
  );
  return rows.length > 0;
}

/** Outbox transacional: gravado na mesma transação da mudança de estado. */
export async function enqueueOutbox(sql: Sql, e: { aggregateType: string; aggregateId: string; eventType: string; payload: unknown; idempotencyKey: string }): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO inventory_outbox_events (aggregate_type, aggregate_id, event_type, payload, idempotency_key)
     VALUES ($1::text, $2::text, $3::text, $4::jsonb, $5::text) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
    [e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e.payload), e.idempotencyKey],
  );
  return rows.length > 0;
}

/**
 * "Despachante" do outbox. Na fase 0 não existe destino: em modo sombra os eventos pendentes são marcados
 * SUPPRESSED_SHADOW (o CHECK do banco impede DISPATCHED). Desativado: não faz nada.
 */
export async function drainOutbox(sql: Sql, limit = 500): Promise<{ suppressed: number }> {
  if (inventoryCoreMode().mode !== "shadow") return { suppressed: 0 };
  const n = await sql.execute(
    `UPDATE inventory_outbox_events SET status = 'SUPPRESSED_SHADOW', processed_at = now(), attempts = attempts + 1
     WHERE id IN (SELECT id FROM inventory_outbox_events WHERE status = 'PENDING' ORDER BY id LIMIT $1::int FOR UPDATE SKIP LOCKED)`,
    [limit],
  );
  return { suppressed: n };
}

export async function audit(sql: Sql, a: { actor: string; action: string; entityType: string; entityId?: string | null; before?: unknown; after?: unknown; correlationId?: string | null }): Promise<void> {
  await sql.execute(
    `INSERT INTO inventory_audit_logs (actor, action, entity_type, entity_id, before, after, correlation_id) VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::text)`,
    [a.actor, a.action, a.entityType, a.entityId ?? null, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.correlationId ?? null],
  );
}
