import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { resetAdsThrottleForTests } from "@/lib/ads/client";
import { hashPassword } from "@/lib/auth/admin";
import { setSchedulerForTesting } from "@/lib/imports/scheduler";
import { setMeliThrottleForTests } from "@/lib/meli/api";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { ADS_BASE, ADS_CNPJ, ADS_KEY, ADS_UA } from "./helpers/ads-mock";
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
  // ADS simulada (tests/helpers/ads-mock.ts) e Supabase Storage simulado.
  ADS_API_BASE_URL: ADS_BASE,
  ADS_API_KEY: ADS_KEY,
  ADS_CNPJ: ADS_CNPJ,
  ADS_USER_AGENT: ADS_UA,
  ADS_PAGE_SIZE: "3",
  ADS_MIN_INTERVAL_MS: "0",
  ADS_RETRY_BASE_MS: "1",
  SUPABASE_URL: "https://storage.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-NAO-REAL",
  SUPABASE_STORAGE_BUCKET: "product-images",
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^(MELI_|ADS_|SUPABASE_)/.test(key)) delete process.env[key];
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
  resetEnvCacheForTests();
  resetAdsThrottleForTests();
  setMeliThrottleForTests(0);
  resetRateLimitsForTests();
  setSchedulerForTesting(() => {}); // o worker é acionado explicitamente nos testes
  setStoreForTesting(new MemoryStore());
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setStoreForTesting(null);
  vi.unstubAllGlobals();
});
