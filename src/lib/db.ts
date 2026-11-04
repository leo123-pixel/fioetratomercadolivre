import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Em funções serverless cada instância aquecida mantém o próprio pool do Prisma. O padrão
 * (núm. de CPUs × 2 + 1) esgota rápido o pooler do Supabase em modo sessão (limite de 15 clientes),
 * o que derruba requisições e o `migrate deploy` do build. Limita o pool por instância, salvo se a
 * própria DATABASE_URL já definir `connection_limit`.
 */
export function runtimeDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    // Pooler em modo transação (porta 6543): o Prisma precisa desligar prepared statements.
    if (url.port === "6543" && !url.searchParams.has("pgbouncer")) url.searchParams.set("pgbouncer", "true");
    if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "2");
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "20");
    return url.toString();
  } catch {
    return raw;
  }
}

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const url = runtimeDatabaseUrl(process.env.DATABASE_URL);
    globalForPrisma.prisma = new PrismaClient({ log: ["error"], ...(url ? { datasources: { db: { url } } } : {}) });
  }
  return globalForPrisma.prisma;
}
