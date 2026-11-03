import "server-only";
import { getPrisma } from "../db";
import type { ConnectionRecord, Store } from "./types";

const tokenFieldsCleared = {
  accessTokenEnc: null,
  refreshTokenEnc: null,
  accessTokenExpiresAt: null,
  refreshLockId: null,
  refreshLockUntil: null,
} as const;

export function createPrismaStore(): Store {
  const prisma = getPrisma();

  return {
    async createOAuthState(input) {
      await prisma.oAuthState.create({ data: input });
    },

    async consumeOAuthState(stateHash, bindingHash, now) {
      // UPDATE condicional: em Postgres, duas requisições simultâneas não conseguem consumir o mesmo state.
      const { count } = await prisma.oAuthState.updateMany({
        where: { stateHash, bindingHash, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (count !== 1) return null;
      return prisma.oAuthState.findUnique({ where: { stateHash } });
    },

    async deleteExpiredOAuthStates(now) {
      const { count } = await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
      return count;
    },

    async getCurrentConnection() {
      return (await prisma.meliConnection.findFirst({
        orderBy: [{ lastConnectedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      })) as ConnectionRecord | null;
    },

    async getConnectionById(id) {
      return (await prisma.meliConnection.findUnique({ where: { id } })) as ConnectionRecord | null;
    },

    async saveAuthorizedConnection(input) {
      const tokenData = {
        nickname: input.nickname,
        siteId: input.siteId,
        accessTokenEnc: input.accessTokenEnc,
        refreshTokenEnc: input.refreshTokenEnc,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        scope: input.scope,
        status: "ACTIVE" as const,
        refreshLockId: null,
        refreshLockUntil: null,
        lastConnectedAt: input.connectedAt,
        lastErrorCode: null,
      };
      const [, connection] = await prisma.$transaction([
        prisma.meliConnection.updateMany({
          where: { meliUserId: { not: input.meliUserId } },
          data: { ...tokenFieldsCleared, status: "DISCONNECTED", tokenVersion: { increment: 1 } },
        }),
        prisma.meliConnection.upsert({
          where: { meliUserId: input.meliUserId },
          create: { meliUserId: input.meliUserId, ...tokenData, tokenVersion: 1 },
          update: { ...tokenData, tokenVersion: { increment: 1 } },
        }),
      ]);
      return connection as ConnectionRecord;
    },

    async tryAcquireRefreshLock(id, lockId, lockUntil, now) {
      const { count } = await prisma.meliConnection.updateMany({
        where: {
          id,
          status: "ACTIVE",
          refreshTokenEnc: { not: null },
          OR: [{ refreshLockUntil: null }, { refreshLockUntil: { lt: now } }],
        },
        data: { refreshLockId: lockId, refreshLockUntil: lockUntil },
      });
      return count === 1;
    },

    async completeRefresh(id, lockId, input) {
      // Rotação atômica: grava o novo par de tokens e libera o lease na mesma instrução.
      const { count } = await prisma.meliConnection.updateMany({
        where: { id, refreshLockId: lockId, status: "ACTIVE" },
        data: {
          accessTokenEnc: input.accessTokenEnc,
          refreshTokenEnc: input.refreshTokenEnc,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          scope: input.scope,
          lastRefreshedAt: input.refreshedAt,
          lastErrorCode: null,
          refreshLockId: null,
          refreshLockUntil: null,
          tokenVersion: { increment: 1 },
        },
      });
      return count === 1;
    },

    async releaseRefreshLock(id, lockId, errorCode) {
      await prisma.meliConnection.updateMany({
        where: { id, refreshLockId: lockId },
        data: { refreshLockId: null, refreshLockUntil: null, lastErrorCode: errorCode },
      });
    },

    async markReauthRequired(id, errorCode) {
      await prisma.meliConnection.update({
        where: { id },
        data: { ...tokenFieldsCleared, status: "REAUTH_REQUIRED", lastErrorCode: errorCode, tokenVersion: { increment: 1 } },
      });
    },

    async clearTokens(id) {
      await prisma.meliConnection.update({
        where: { id },
        data: { ...tokenFieldsCleared, status: "DISCONNECTED", lastErrorCode: null, tokenVersion: { increment: 1 } },
      });
    },

    async getLoginLockedUntil(keyHash, now) {
      const row = await prisma.adminLoginThrottle.findUnique({ where: { keyHash } });
      return row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
    },

    async recordLoginFailure(keyHash, now, maxFailures, lockMs) {
      const row = await prisma.adminLoginThrottle.upsert({
        where: { keyHash },
        create: { keyHash, failures: 1 },
        update: { failures: { increment: 1 } },
      });
      if (row.failures >= maxFailures) {
        await prisma.adminLoginThrottle.update({
          where: { keyHash },
          data: { failures: 0, lockedUntil: new Date(now.getTime() + lockMs) },
        });
      }
    },

    async clearLoginFailures(keyHash) {
      await prisma.adminLoginThrottle.deleteMany({ where: { keyHash } });
    },
  };
}
