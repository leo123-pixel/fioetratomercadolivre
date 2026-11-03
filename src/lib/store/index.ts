import "server-only";
import { createPrismaStore } from "./prisma";
import type { Store } from "./types";

let store: Store | null = null;

export function getStore(): Store {
  if (!store) store = createPrismaStore();
  return store;
}

/** Somente para testes automatizados. Em produção o armazenamento é sempre o PostgreSQL. */
export function setStoreForTesting(testStore: Store | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setStoreForTesting só pode ser usado em testes");
  store = testStore;
}

export type { Store } from "./types";
