import "server-only";
import { adsEnvironment } from "../ads/client";
import type { Sql } from "../sql";
import { ensurePool, ensureSkus, poolKeyOf } from "./identity";
import { recordMovement, withPoolLock, type MovementOrigin, type MovementType } from "./ledger";
import { InventoryError } from "./mode";
import { applyEvents, changedFacts, deriveState, EMPTY_FACTS, type ReflectionPolicy, type ReservationEvent, type ReservationEventType, type ReservationFacts, type ReservationState } from "./reservations";
import type { InventorySettings } from "./settings";

/**
 * Compromissos de estoque a partir dos pedidos dos canais (Inbox / deduplicação).
 *
 * recordOrderEvents() é o ponto único de entrada de eventos de pedido — usado pela leitura dos pedidos do
 * Mercado Livre (já gravados pelo fluxo existente em marketplace_order_inbox; nenhuma chamada ao ML aqui)
 * e, no futuro, por webhooks de outros canais. Cada compromisso é identificado por
 * canal + pedido + linha + produto físico (unicidade no banco): o mesmo pedido nunca gera duas reservas.
 */

export interface OrderLineEventInput {
  channel: string;
  externalOrderId: string;
  lineKey: string;
  productId: number;
  quantity: number;
  events: ReservationEvent[];
  orderCreatedAt?: Date | null;
  sourceVersion?: Date | null;
  ads?: { externalId?: string | null; pedidoId?: number | null; submissionStatus?: string | null; status?: string | null };
  simulated?: boolean;
  correlationId: string;
  warehouseCode: string;
}

export interface ReservationResult {
  reservationId: string;
  poolId: string;
  poolKey: string;
  state: ReservationState;
  previous: ReservationState | null;
  created: boolean;
  changed: boolean;
}

const FACT_MOVEMENT: Record<ReservationEventType, { type: MovementType; origin: MovementOrigin }> = {
  ORDER_RECEIVED: { type: "ORDER_RECEIVED", origin: "ML_ORDER_INBOX" },
  ORDER_CANCELLED: { type: "ORDER_CANCELLED", origin: "ML_ORDER_INBOX" },
  ORDER_RETURNED: { type: "ORDER_RETURNED", origin: "ML_ORDER_INBOX" },
  ADS_ORDER_CREATED: { type: "ADS_ORDER_CREATED", origin: "ADS_SUBMISSION" },
  ADS_ORDER_UNCERTAIN: { type: "ADS_ORDER_UNCERTAIN", origin: "ADS_SUBMISSION" },
  ADS_ORDER_FAILED: { type: "ADS_ORDER_FAILED", origin: "ADS_SUBMISSION" },
  ADS_STOCK_CONFIRMED: { type: "ADS_STOCK_CONFIRMED", origin: "ADS_SUBMISSION" },
  ADS_ORDER_CANCELLED: { type: "ADS_ORDER_CANCELLED", origin: "ADS_SUBMISSION" },
  STALE_PENDING: { type: "STOCK_DISCREPANCY", origin: "INVENTORY_CORE" },
};

const STATE_MOVEMENT: Record<ReservationState, MovementType> = {
  PENDING_ERP: "ORDER_RESERVED",
  REQUIRES_RECONCILIATION: "STOCK_DISCREPANCY",
  REFLECTED_IN_ERP: "STOCK_RECONCILED",
  RELEASED: "STOCK_RELEASED",
};

interface StoredReservation {
  id: string;
  state: ReservationState;
  facts: ReservationFacts;
  version: number;
  poolId: string;
}

async function selectReservation(tx: Sql, key: string): Promise<StoredReservation | null> {
  const [r] = await tx.query<StoredReservation>(
    `SELECT id::text AS id, state, facts, version, pool_id::text AS "poolId" FROM inventory_reservations WHERE idempotency_key = $1::text FOR UPDATE`,
    [key],
  );
  return r ?? null;
}

export function reservationKey(channel: string, externalOrderId: string, lineKey: string, productId: number) {
  return `${channel}:${externalOrderId}:${lineKey}:${productId}`;
}

/** Aplica os eventos de uma linha de pedido (um produto físico) ao compromisso correspondente. */
export async function recordOrderEvents(sql: Sql, input: OrderLineEventInput, policy: ReflectionPolicy): Promise<ReservationResult> {
  if (!(input.quantity > 0)) throw new InventoryError("invalid_quantity", "Quantidade do pedido deve ser positiva", 422);
  const skus = await ensureSkus(sql, [input.productId]);
  const sku = skus.get(input.productId);
  if (!sku) throw new InventoryError("product_not_found", `Produto ${input.productId} não encontrado`, 404);
  const pool = await ensurePool(sql, sku, input.warehouseCode);
  const key = reservationKey(input.channel, input.externalOrderId, input.lineKey, input.productId);
  return withPoolLock(sql, pool.poolKey, async (tx) => {
    let row = await selectReservation(tx, key);
    let created = false;
    const prevFacts = row?.facts ? { ...EMPTY_FACTS, ...row.facts } : EMPTY_FACTS;
    const facts = applyEvents(prevFacts, input.events);
    const derived = deriveState(facts, policy, row?.state ?? null);
    if (!row) {
      const inserted = await tx.query<StoredReservation>(
        `INSERT INTO inventory_reservations (pool_id, product_id, channel, external_order_id, line_key, quantity, state, state_reason, facts,
           ads_external_id, ads_pedido_id, ads_submission_status, ads_status, order_created_at, source_version, simulated, correlation_id, idempotency_key)
         VALUES ($1::bigint, $2::int, $3::text, $4::text, $5::text, $6::numeric, $7::text, $8::text, $9::jsonb, $10::text, $11::int, $12::text, $13::text,
           $14::timestamptz, $15::timestamptz, $16::boolean, $17::text, $18::text)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id::text AS id, state, facts, version, pool_id::text AS "poolId"`,
        [
          pool.id,
          input.productId,
          input.channel,
          input.externalOrderId,
          input.lineKey,
          String(input.quantity),
          derived.state,
          derived.reason,
          JSON.stringify(facts),
          input.ads?.externalId ?? null,
          input.ads?.pedidoId ?? null,
          input.ads?.submissionStatus ?? null,
          input.ads?.status ?? null,
          input.orderCreatedAt?.toISOString() ?? null,
          input.sourceVersion?.toISOString() ?? null,
          input.simulated ?? false,
          input.correlationId,
          key,
        ],
      );
      if (inserted[0]) {
        row = inserted[0];
        created = true;
      } else {
        // Corrida com outro processo (sem o lock, ex.: outra instância antiga): relê e segue como atualização.
        row = await selectReservation(tx, key);
        if (!row) throw new InventoryError("reservation_race", "Compromisso concorrente não encontrado", 500);
        return recordOrderEventsOnExisting(tx, row, input, policy, pool, key);
      }
    } else {
      return recordOrderEventsOnExisting(tx, row, input, policy, pool, key);
    }
    await writeMovements(tx, row.id, pool, input, EMPTY_FACTS, facts, null, derived.state, 1);
    return { reservationId: row.id, poolId: pool.id, poolKey: pool.poolKey, state: derived.state, previous: null, created, changed: true };
  });
}

async function recordOrderEventsOnExisting(
  tx: Sql,
  row: StoredReservation,
  input: OrderLineEventInput,
  policy: ReflectionPolicy,
  pool: { id: string; poolKey: string; warehouseCode: string },
  key: string,
): Promise<ReservationResult> {
  const prevFacts = { ...EMPTY_FACTS, ...row.facts };
  const facts = applyEvents(prevFacts, input.events);
  const derived = deriveState(facts, policy, row.state);
  const factsChanged = JSON.stringify(prevFacts) !== JSON.stringify(facts);
  if (!factsChanged && derived.state === row.state) {
    return { reservationId: row.id, poolId: row.poolId, poolKey: pool.poolKey, state: row.state, previous: row.state, created: false, changed: false };
  }
  const n = await tx.execute(
    `UPDATE inventory_reservations SET state = $3::text, state_reason = $4::text, facts = $5::jsonb,
       ads_external_id = COALESCE($6::text, ads_external_id), ads_pedido_id = COALESCE($7::int, ads_pedido_id),
       ads_submission_status = COALESCE($8::text, ads_submission_status), ads_status = COALESCE($9::text, ads_status),
       source_version = GREATEST(source_version, $10::timestamptz), version = version + 1, updated_at = now()
     WHERE id = $1::bigint AND version = $2::int`,
    [row.id, row.version, derived.state, derived.reason, JSON.stringify(facts), input.ads?.externalId ?? null, input.ads?.pedidoId ?? null, input.ads?.submissionStatus ?? null, input.ads?.status ?? null, input.sourceVersion?.toISOString() ?? null],
  );
  if (n !== 1) throw new InventoryError("reservation_version_conflict", `Compromisso ${key} alterado em paralelo`, 409);
  await writeMovements(tx, row.id, { ...pool, id: row.poolId }, input, prevFacts, facts, row.state, derived.state, row.version + 1);
  return { reservationId: row.id, poolId: row.poolId, poolKey: pool.poolKey, state: derived.state, previous: row.state, created: false, changed: true };
}

async function writeMovements(
  tx: Sql,
  reservationId: string,
  pool: { id: string; warehouseCode: string },
  input: OrderLineEventInput,
  before: ReservationFacts,
  after: ReservationFacts,
  fromState: ReservationState | null,
  toState: ReservationState,
  version: number,
) {
  const base = {
    poolId: pool.id,
    productId: input.productId,
    warehouseCode: pool.warehouseCode,
    channel: input.channel,
    externalOrderId: input.externalOrderId,
    reservationId,
    quantity: input.quantity,
    correlationId: input.correlationId,
    simulated: input.simulated ?? false,
  };
  for (const fact of changedFacts(before, after)) {
    const m = FACT_MOVEMENT[fact];
    const origin: MovementOrigin = input.simulated ? "SIMULATION" : input.channel !== "mercadolivre" && m.origin === "ML_ORDER_INBOX" ? "INVENTORY_CORE" : m.origin;
    await recordMovement(tx, {
      ...base,
      type: m.type,
      origin,
      // Fatos da ADS e do canal são observados: o Inventory Core não é o autor da baixa física.
      responsibility: fact === "STALE_PENDING" ? "INTERNAL" : "OBSERVED",
      status: fact === "STALE_PENDING" ? "INFORMATIONAL" : "RECORDED",
      occurredAt: fact.startsWith("ADS_ORDER") && after.adsSubmissionAt ? after.adsSubmissionAt : input.orderCreatedAt ?? null,
      idempotencyKey: `res:${reservationId}:${fact}:${fact.startsWith("ADS_ORDER_") ? (after.adsSubmissionAt ?? "") : ""}`,
      details: fact === "STALE_PENDING" ? { reason: "Pendente há tempo demais sem evidência de baixa na ADS" } : input.ads ? { ads: input.ads } : undefined,
    });
  }
  if (fromState !== toState) {
    await recordMovement(tx, {
      ...base,
      type: STATE_MOVEMENT[toState],
      origin: input.simulated ? "SIMULATION" : "INVENTORY_CORE",
      responsibility: "INTERNAL",
      status: toState === "REQUIRES_RECONCILIATION" ? "INFORMATIONAL" : "RECORDED",
      idempotencyKey: `res:${reservationId}:state:${version}:${toState}`,
      details: { from: fromState, to: toState, note: toState === "REFLECTED_IN_ERP" ? "Compromisso local encerrado: a baixa já consta no saldo ADS (feita pela ADS, não pelo Inventory Core)" : undefined },
    });
  }
}

// ---------------------------------------------------------------------------
// Leitura dos pedidos do Mercado Livre já recebidos pelo fluxo existente (somente banco local).
// ---------------------------------------------------------------------------

interface OrderLineFact {
  orderId: string;
  orderStatus: string | null;
  createdAt: Date;
  mlLastUpdated: Date | null;
  lineKey: string;
  itemId: string;
  qty: string;
  mappingStatus: string;
  productId: number | null;
  components: { productId: number; quantity: number }[] | null;
  subStatus: string | null;
  externalId: string | null;
  adsPedidoId: number | null;
  adsStatus: string | null;
  subUpdatedAt: Date | null;
}

export interface IngestResult {
  lines: number;
  reservations: number;
  created: number;
  changed: number;
  productIds: number[];
  unmapped: { orderId: string; itemId: string; lineKey: string; quantity: string; createdAt: Date }[];
  byState: Record<string, number>;
}

function currentAdsEnvironment(): string {
  try {
    return adsEnvironment().environment;
  } catch {
    return "producao";
  }
}

const matchesAny = (value: string | null, list: string[]) => !!value && list.some((s) => value.toLowerCase().includes(s.toLowerCase()));

export async function ingestMercadoLivreOrders(sql: Sql, opts: { settings: InventorySettings; correlationId: string; now?: Date }): Promise<IngestResult> {
  const s = opts.settings;
  const env = currentAdsEnvironment();
  const now = opts.now ?? new Date();
  const lines = await sql.query<OrderLineFact>(
    `SELECT o.marketplace_order_id AS "orderId", o.order_status AS "orderStatus", COALESCE(o.date_created, o.received_at) AS "createdAt",
            o.ml_last_updated AS "mlLastUpdated", i.line_key AS "lineKey", i.marketplace_item_id AS "itemId", trim_scale(i.quantity)::text AS qty,
            i.mapping_status AS "mappingStatus", i.product_id AS "productId",
            (SELECT json_agg(json_build_object('productId', c.product_id, 'quantity', c.quantity) ORDER BY c.product_id)
             FROM marketplace_mapping_components c WHERE c.mapping_id = i.mapping_id) AS components,
            sub.status AS "subStatus", sub.external_id AS "externalId", sub.ads_pedido_id AS "adsPedidoId", sub.ads_status AS "adsStatus", sub.updated_at AS "subUpdatedAt"
     FROM marketplace_order_items i
     JOIN marketplace_order_inbox o ON o.id = i.order_id
     -- O envio de um pack fica no pedido principal: vale para todos os pedidos do mesmo pack.
     LEFT JOIN LATERAL (
       SELECT s.status, s.external_id, s.ads_pedido_id, s.ads_status, s.updated_at FROM ads_order_submissions s
       JOIN marketplace_order_inbox o2 ON o2.id = s.order_id
       WHERE s.environment = $2::text AND (o2.id = o.id OR (o.pack_id IS NOT NULL AND o2.pack_id = o.pack_id))
       ORDER BY CASE WHEN s.status IN ('SENT', 'SENDING', 'UNKNOWN') THEN 0 ELSE 1 END, s.created_at DESC LIMIT 1
     ) sub ON true
     WHERE COALESCE(o.date_created, o.received_at) > now() - make_interval(days => $1::int)
        OR o.marketplace_order_id IN (SELECT external_order_id FROM inventory_reservations
                                      WHERE channel = 'mercadolivre' AND NOT simulated AND state IN ('PENDING_ERP', 'REQUIRES_RECONCILIATION'))
     ORDER BY o.id, i.id`,
    [s.orderLookbackDays, env],
  );
  const policy: ReflectionPolicy = { adsDeductsOnOrderCreated: s.adsDeductsOnOrderCreated };
  const result: IngestResult = { lines: lines.length, reservations: 0, created: 0, changed: 0, productIds: [], unmapped: [], byState: {} };
  const touched = new Set<number>();
  const allIds = [...new Set(lines.flatMap((l) => (l.components?.length ? l.components.map((c) => c.productId) : l.productId ? [l.productId] : [])))];
  await ensureSkus(sql, allIds);
  // Pré-leitura em lote: linhas cujos fatos e estado não mudaram não abrem transação.
  const existing = new Map(
    (
      await sql.query<{ key: string; state: ReservationState; facts: ReservationFacts }>(
        `SELECT idempotency_key AS key, state, facts FROM inventory_reservations WHERE channel = 'mercadolivre' AND external_order_id = ANY($1::text[])`,
        [[...new Set(lines.map((l) => l.orderId))]],
      )
    ).map((r) => [r.key, r]),
  );
  for (const l of lines) {
    const cancelled = ["cancelled", "invalid"].includes(l.orderStatus ?? "");
    if (l.mappingStatus !== "MAPPED" || !l.productId) {
      if (!cancelled) result.unmapped.push({ orderId: l.orderId, itemId: l.itemId, lineKey: l.lineKey, quantity: l.qty, createdAt: new Date(l.createdAt) });
      continue;
    }
    const events: ReservationEvent[] = [{ type: "ORDER_RECEIVED" }];
    if (cancelled) events.push({ type: "ORDER_CANCELLED" });
    const subAt = l.subUpdatedAt ? new Date(l.subUpdatedAt) : null;
    if (l.subStatus === "SENT") events.push({ type: "ADS_ORDER_CREATED", at: subAt });
    else if (l.subStatus === "SENDING" || l.subStatus === "UNKNOWN") events.push({ type: "ADS_ORDER_UNCERTAIN", at: subAt });
    else if (l.subStatus === "FAILED" || l.subStatus === "CANCELED") events.push({ type: "ADS_ORDER_FAILED", at: subAt });
    if (l.subStatus === "SENT" && /cancel/i.test(l.adsStatus ?? "")) events.push({ type: "ADS_ORDER_CANCELLED" });
    else if (l.subStatus === "SENT" && matchesAny(l.adsStatus, s.adsReflectedStatuses)) events.push({ type: "ADS_STOCK_CONFIRMED" });
    const ageDays = (now.getTime() - new Date(l.createdAt).getTime()) / 86_400_000;
    if (ageDays > s.pendingReconcileAfterDays) events.push({ type: "STALE_PENDING" });
    const components = l.components?.length ? l.components : [{ productId: l.productId, quantity: 1 }];
    for (const c of components) {
      const ex = existing.get(reservationKey("mercadolivre", l.orderId, l.lineKey, c.productId));
      if (ex) {
        const prev = { ...EMPTY_FACTS, ...ex.facts };
        const facts = applyEvents(prev, events);
        if (JSON.stringify(prev) === JSON.stringify(facts) && deriveState(facts, policy, ex.state).state === ex.state) {
          result.reservations++;
          result.byState[ex.state] = (result.byState[ex.state] ?? 0) + 1;
          touched.add(c.productId);
          continue;
        }
      }
      const r = await recordOrderEvents(
        sql,
        {
          channel: "mercadolivre",
          externalOrderId: l.orderId,
          lineKey: l.lineKey,
          productId: c.productId,
          quantity: Number(l.qty) * c.quantity,
          events,
          orderCreatedAt: new Date(l.createdAt),
          sourceVersion: l.mlLastUpdated ? new Date(l.mlLastUpdated) : null,
          ads: { externalId: l.externalId, pedidoId: l.adsPedidoId, submissionStatus: l.subStatus, status: l.adsStatus },
          correlationId: opts.correlationId,
          warehouseCode: s.channelWarehouses.mercadolivre ?? "principal",
        },
        policy,
      );
      result.reservations++;
      if (r.created) result.created++;
      if (r.changed) result.changed++;
      result.byState[r.state] = (result.byState[r.state] ?? 0) + 1;
      touched.add(c.productId);
    }
  }
  result.productIds = [...touched];
  return result;
}

export { poolKeyOf };
