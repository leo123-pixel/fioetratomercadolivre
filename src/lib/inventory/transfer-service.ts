import "server-only";
import { randomUUID } from "node:crypto";
import { isUniqueViolation, type Sql } from "../sql";
import { audit, recordMovement, withPoolLock } from "./ledger";
import { assertInventoryEnabled, InventoryError } from "./mode";
import type { Reliability } from "./position";
import { OPEN_TRANSFER_STATES, runTransferProtocol, SimulatedTransferExecutor, type RemoteOutcome, type TransferExecutor, type TransferState, type TransferStep } from "./transfer";

/**
 * Transferência de cota entre canais — SOMENTE SIMULAÇÃO na fase 0 (o banco exige simulated = true).
 * Cada passo é gravado em sua própria transação ANTES do seguinte (no protocolo real, as chamadas
 * externas ficariam entre essas transações, nunca dentro delas). As cotas reais
 * (inventory_channel_allocations) NÃO são alteradas pela simulação.
 */
export interface TransferView {
  id: string;
  poolId: string;
  poolKey: string;
  fromChannel: string;
  toChannel: string;
  quantity: number;
  state: TransferState;
  simulated: boolean;
  steps: TransferStep[];
  error: string | null;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = `t.id::text AS id, t.pool_id::text AS "poolId", p.pool_key AS "poolKey", t.from_channel AS "fromChannel", t.to_channel AS "toChannel",
  t.quantity, t.state, t.simulated, t.steps, t.error, t.requested_by AS "requestedBy", t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

export async function listTransfers(sql: Sql, limit = 30): Promise<TransferView[]> {
  return sql.query<TransferView>(`SELECT ${COLS} FROM inventory_quota_transfers t JOIN inventory_pools p ON p.id = t.pool_id ORDER BY t.created_at DESC LIMIT $1::int`, [limit]);
}

async function getTransfer(sql: Sql, id: string): Promise<TransferView> {
  const [t] = await sql.query<TransferView>(`SELECT ${COLS} FROM inventory_quota_transfers t JOIN inventory_pools p ON p.id = t.pool_id WHERE t.id = $1::uuid`, [id]);
  if (!t) throw new InventoryError("transfer_not_found", "Transferência não encontrada", 404);
  return t;
}

export interface SimulateTransferInput {
  poolId: string;
  fromChannel: string;
  toChannel: string;
  quantity: number;
  /** Resultado simulado de cada etapa remota (padrão: confirmado). */
  outcomes?: { sourceDecrease?: RemoteOutcome; destinationIncrease?: RemoteOutcome };
  requestedBy: string;
  idempotencyKey?: string;
  /** Somente testes: substitui o executor simulado (ex.: o executor real bloqueado pelo portão). */
  executor?: TransferExecutor;
}

export async function simulateQuotaTransfer(sql: Sql, input: SimulateTransferInput): Promise<TransferView> {
  assertInventoryEnabled();
  const [pool] = await sql.query<{ id: string; poolKey: string; safeSellable: number | null; reliability: Reliability }>(
    `SELECT id::text AS id, pool_key AS "poolKey", safe_sellable AS "safeSellable", reliability FROM inventory_pools WHERE id = $1::bigint`,
    [input.poolId],
  );
  if (!pool) throw new InventoryError("pool_not_found", "Pool não encontrado", 404);
  const idem = input.idempotencyKey ?? `transfer:${randomUUID()}`;
  const [existing] = await sql.query<{ id: string }>(`SELECT id::text AS id FROM inventory_quota_transfers WHERE idempotency_key = $1::text`, [idem]);
  if (existing) return getTransfer(sql, existing.id);

  const allocs = new Map(
    (
      await sql.query<{ channel: string; desired: number | null }>(`SELECT channel, desired_quantity AS desired FROM inventory_channel_allocations WHERE pool_id = $1::bigint`, [pool.id])
    ).map((a) => [a.channel, a.desired ?? 0]),
  );
  const correlationId = randomUUID();
  let id: string;
  try {
    id = await withPoolLock(sql, pool.poolKey, async (tx) => {
      const [t] = await tx.query<{ id: string }>(
        `INSERT INTO inventory_quota_transfers (pool_id, from_channel, to_channel, quantity, state, simulated, requested_by, idempotency_key, correlation_id)
         VALUES ($1::bigint, $2::text, $3::text, $4::int, 'REQUESTED', true, $5::text, $6::text, $7::text) RETURNING id::text AS id`,
        [pool.id, input.fromChannel, input.toChannel, input.quantity, input.requestedBy, idem, correlationId],
      );
      await recordMovement(tx, {
        type: "QUOTA_TRANSFER_REQUESTED",
        poolId: pool.id,
        channel: input.fromChannel,
        quantity: input.quantity,
        origin: "SIMULATION",
        responsibility: "INTERNAL",
        simulated: true,
        correlationId,
        idempotencyKey: `transfer:${t.id}:requested`,
        details: { from: input.fromChannel, to: input.toChannel },
      });
      await audit(tx, { actor: input.requestedBy, action: "transfer_simulated", entityType: "transfer", entityId: t.id, after: { ...input, executor: undefined }, correlationId });
      return t.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new InventoryError("transfer_open", "Já existe uma transferência aberta (ou bloqueada) para este pool: conclua ou cancele antes", 409);
    throw err;
  }

  const executor = input.executor ?? new SimulatedTransferExecutor(input.outcomes);
  const result = await runTransferProtocol(
    {
      fromChannel: input.fromChannel,
      toChannel: input.toChannel,
      quantity: input.quantity,
      sourceQuota: allocs.get(input.fromChannel) ?? 0,
      destinationQuota: allocs.get(input.toChannel) ?? 0,
      safeSellable: pool.safeSellable,
      reliability: pool.reliability,
    },
    executor,
    async (step) => {
      // Um passo por transação, com controle de versão.
      await withPoolLock(sql, pool.poolKey, async (tx) => {
        const n = await tx.execute(
          `UPDATE inventory_quota_transfers SET state = $2::text, steps = steps || $3::jsonb, error = CASE WHEN $2::text IN ('BLOCKED', 'REQUIRES_RECONCILIATION', 'REJECTED') THEN $4::text ELSE error END,
             version = version + 1, updated_at = now() WHERE id = $1::uuid AND state NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')`,
          [id, step.state, JSON.stringify([step]), step.note],
        );
        if (n !== 1) throw new InventoryError("transfer_closed", "Transferência encerrada por outro processo", 409);
      });
    },
  );
  const finalType = result.state === "COMPLETED" ? "QUOTA_TRANSFER_CONFIRMED" : "QUOTA_TRANSFER_BLOCKED";
  await recordMovement(sql, {
    type: finalType,
    poolId: pool.id,
    channel: input.toChannel,
    quantity: input.quantity,
    status: result.state === "COMPLETED" ? "RECORDED" : "INFORMATIONAL",
    origin: "SIMULATION",
    responsibility: "INTERNAL",
    simulated: true,
    correlationId,
    idempotencyKey: `transfer:${id}:final`,
    details: { state: result.state, error: result.error, executor: executor.simulated ? "SIMULATED" : "GATED_REMOTE" },
  });
  return getTransfer(sql, id);
}

export async function cancelTransfer(sql: Sql, id: string, actor: string): Promise<TransferView> {
  assertInventoryEnabled();
  const t = await getTransfer(sql, id);
  if (!OPEN_TRANSFER_STATES.includes(t.state)) throw new InventoryError("transfer_closed", `Transferência já encerrada (${t.state})`, 409);
  await withPoolLock(sql, t.poolKey, async (tx) => {
    await tx.execute(`UPDATE inventory_quota_transfers SET state = 'CANCELLED', version = version + 1, updated_at = now() WHERE id = $1::uuid AND state <> 'CANCELLED'`, [id]);
    await audit(tx, { actor, action: "transfer_cancelled", entityType: "transfer", entityId: id, before: { state: t.state } });
  });
  return getTransfer(sql, id);
}
