import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import type { ConnectionRecord, OAuthStateRecord, Store } from "@/lib/store/types";

/**
 * Implementação em memória com a mesma semântica condicional do PrismaStore.
 * Uso exclusivo em testes: em produção serverless os estados vivem no PostgreSQL.
 */
export class MemoryStore implements Store {
  states = new Map<string, OAuthStateRecord>();
  connections = new Map<string, ConnectionRecord>();
  throttle = new Map<string, { failures: number; lockedUntil: Date | null }>();

  async createOAuthState(input: Parameters<Store["createOAuthState"]>[0]) {
    this.states.set(input.stateHash, { id: randomUUID(), consumedAt: null, createdAt: new Date(), ...input });
  }

  async consumeOAuthState(stateHash: string, bindingHash: string, now: Date) {
    const record = this.states.get(stateHash);
    if (!record || record.bindingHash !== bindingHash || record.consumedAt || record.expiresAt <= now) return null;
    record.consumedAt = now;
    return { ...record };
  }

  async deleteExpiredOAuthStates(now: Date) {
    let count = 0;
    for (const [key, value] of this.states) {
      if (value.expiresAt < now) {
        this.states.delete(key);
        count++;
      }
    }
    return count;
  }

  async getCurrentConnection() {
    const all = [...this.connections.values()].sort((a, b) => (b.lastConnectedAt?.getTime() ?? 0) - (a.lastConnectedAt?.getTime() ?? 0));
    return all[0] ? { ...all[0] } : null;
  }

  async getConnectionById(id: string) {
    const conn = this.connections.get(id);
    return conn ? { ...conn } : null;
  }

  async saveAuthorizedConnection(input: Parameters<Store["saveAuthorizedConnection"]>[0]) {
    for (const conn of this.connections.values()) {
      if (conn.meliUserId !== input.meliUserId) Object.assign(conn, this.cleared(), { status: "DISCONNECTED", tokenVersion: conn.tokenVersion + 1 });
    }
    const existing = [...this.connections.values()].find((c) => c.meliUserId === input.meliUserId);
    const now = new Date();
    const record: ConnectionRecord = {
      id: existing?.id ?? randomUUID(),
      meliUserId: input.meliUserId,
      nickname: input.nickname,
      siteId: input.siteId,
      accessTokenEnc: input.accessTokenEnc,
      refreshTokenEnc: input.refreshTokenEnc,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      scope: input.scope,
      status: "ACTIVE",
      tokenVersion: (existing?.tokenVersion ?? 0) + 1,
      refreshLockId: null,
      refreshLockUntil: null,
      lastConnectedAt: input.connectedAt,
      lastRefreshedAt: existing?.lastRefreshedAt ?? null,
      lastErrorCode: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.connections.set(record.id, record);
    return { ...record };
  }

  async tryAcquireRefreshLock(id: string, lockId: string, lockUntil: Date, now: Date) {
    const conn = this.connections.get(id);
    if (!conn || conn.status !== "ACTIVE" || !conn.refreshTokenEnc) return false;
    if (conn.refreshLockUntil && conn.refreshLockUntil >= now) return false;
    conn.refreshLockId = lockId;
    conn.refreshLockUntil = lockUntil;
    return true;
  }

  async completeRefresh(id: string, lockId: string, input: Parameters<Store["completeRefresh"]>[2]) {
    const conn = this.connections.get(id);
    if (!conn || conn.refreshLockId !== lockId || conn.status !== "ACTIVE") return false;
    Object.assign(conn, {
      accessTokenEnc: input.accessTokenEnc,
      refreshTokenEnc: input.refreshTokenEnc,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      scope: input.scope,
      lastRefreshedAt: input.refreshedAt,
      lastErrorCode: null,
      refreshLockId: null,
      refreshLockUntil: null,
      tokenVersion: conn.tokenVersion + 1,
    });
    return true;
  }

  async releaseRefreshLock(id: string, lockId: string, errorCode: string | null) {
    const conn = this.connections.get(id);
    if (conn && conn.refreshLockId === lockId) Object.assign(conn, { refreshLockId: null, refreshLockUntil: null, lastErrorCode: errorCode });
  }

  async markReauthRequired(id: string, errorCode: string) {
    const conn = this.connections.get(id);
    if (conn) Object.assign(conn, this.cleared(), { status: "REAUTH_REQUIRED", lastErrorCode: errorCode, tokenVersion: conn.tokenVersion + 1 });
  }

  async clearTokens(id: string) {
    const conn = this.connections.get(id);
    if (conn) Object.assign(conn, this.cleared(), { status: "DISCONNECTED", lastErrorCode: null, tokenVersion: conn.tokenVersion + 1 });
  }

  async getLoginLockedUntil(keyHash: string, now: Date) {
    const row = this.throttle.get(keyHash);
    return row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
  }

  async recordLoginFailure(keyHash: string, now: Date, maxFailures: number, lockMs: number) {
    const row = this.throttle.get(keyHash) ?? { failures: 0, lockedUntil: null };
    row.failures++;
    if (row.failures >= maxFailures) {
      row.failures = 0;
      row.lockedUntil = new Date(now.getTime() + lockMs);
    }
    this.throttle.set(keyHash, row);
  }

  async clearLoginFailures(keyHash: string) {
    this.throttle.delete(keyHash);
  }

  private cleared() {
    return { accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, refreshLockId: null, refreshLockUntil: null };
  }
}

export function memoryStore(): MemoryStore {
  return getStore() as MemoryStore;
}
