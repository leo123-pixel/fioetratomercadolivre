import "server-only";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "./db";

/**
 * Executor SQL mínimo usado pelo catálogo e pelas importações.
 *
 * As consultas são sempre parametrizadas ($1, $2...) — nunca concatenar valores no texto.
 * Valores DECIMAL são lidos com cast ::text para não passarem por ponto flutuante.
 * Em produção o executor usa o Prisma; nos testes, um PostgreSQL embarcado (PGlite)
 * roda exatamente as mesmas migrations e consultas.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  execute(text: string, params?: unknown[]): Promise<number>;
  /** Executa `fn` numa transação. Chamadas aninhadas reutilizam a transação corrente. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

type RawClient = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

function wrapPrisma(client: RawClient, txRunner?: <T>(fn: (tx: RawClient) => Promise<T>) => Promise<T>): Sql {
  const sql: Sql = {
    query: <T>(text: string, params: unknown[] = []) => client.$queryRawUnsafe<T[]>(text, ...params),
    execute: (text: string, params: unknown[] = []) => client.$executeRawUnsafe(text, ...params),
    transaction: <T>(fn: (tx: Sql) => Promise<T>) => (txRunner ? txRunner((tx) => fn(wrapPrisma(tx))) : fn(sql)),
  };
  return sql;
}

let current: Sql | null = null;

export function getSql(): Sql {
  if (!current) {
    const prisma = getPrisma();
    current = wrapPrisma(prisma, (fn) => prisma.$transaction((tx) => fn(tx), { timeout: 30_000, maxWait: 10_000 }));
  }
  return current;
}

/** Somente para testes automatizados. */
export function setSqlForTesting(sql: Sql | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setSqlForTesting só pode ser usado em testes");
  current = sql;
}

/** Violação de unicidade (PostgreSQL 23505), vinda do Prisma ou do driver de teste. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  return e?.code === "23505" || e?.meta?.code === "23505" || /23505|unique constraint/i.test(e?.message ?? "");
}
