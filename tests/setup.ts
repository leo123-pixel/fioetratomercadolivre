import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { hashPassword } from "@/lib/auth/admin";
import { resetEnvCacheForTests } from "@/lib/env";
import { setStoreForTesting } from "@/lib/store";
import { TEST_PASSWORD } from "./helpers/fixtures";
import { MemoryStore } from "./helpers/memory-store";

// Valores exclusivamente de teste, gerados a cada execução. Nenhuma credencial real.
const TEST_ENV = {
  MELI_CLIENT_ID: "1234567890",
  MELI_CLIENT_SECRET: "test-client-secret",
  APP_BASE_URL: "https://integrador.test",
  MELI_REDIRECT_URI: "https://integrador.test/api/auth/mercadolivre/callback",
  MELI_PKCE_ENABLED: "true",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ADMIN_PASSWORD_HASH: await hashPassword(TEST_PASSWORD, 1024),
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("MELI_")) delete process.env[key];
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
  resetEnvCacheForTests();
  setStoreForTesting(new MemoryStore());
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setStoreForTesting(null);
  vi.unstubAllGlobals();
});
