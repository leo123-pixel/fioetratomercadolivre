import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth/admin";
import { safeNextPath } from "@/lib/auth/server-session";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ConfigError, getEnv, resetEnvCacheForTests } from "@/lib/env";
import { redactString, sanitize } from "@/lib/logger";

describe("7. criptografia dos tokens em repouso (AES-256-GCM)", () => {
  it("cifra e decifra; ciphertext não contém o valor e muda a cada chamada", () => {
    const a = encryptSecret("APP_USR-SEGREDO", "ctx");
    const b = encryptSecret("APP_USR-SEGREDO", "ctx");
    expect(a).not.toContain("SEGREDO");
    expect(a).not.toBe(b);
    expect(decryptSecret(a, "ctx")).toBe("APP_USR-SEGREDO");
  });

  it("detecta adulteração e uso fora do contexto (AAD)", () => {
    const enc = encryptSecret("valor", "meli:access_token:42");
    expect(() => decryptSecret(enc, "meli:refresh_token:42")).toThrow();
    const parts = enc.split(".");
    parts[3] = Buffer.from("adulterado").toString("base64url");
    expect(() => decryptSecret(parts.join("."), "meli:access_token:42")).toThrow();
  });
});

describe("sessão do administrador", () => {
  it("rejeita token com payload alterado", () => {
    const [payload, sig] = createSessionToken().split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), exp: 9999999999 })).toString("base64url");
    expect(verifySessionToken(`${tampered}.${sig}`)).toBeNull();
  });

  it("safeNextPath evita open redirect", () => {
    expect(safeNextPath("/configuracoes", "/x")).toBe("/configuracoes");
    expect(safeNextPath("//evil.com", "/x")).toBe("/x");
    expect(safeNextPath("https://evil.com", "/x")).toBe("/x");
    expect(safeNextPath("/\\evil.com", "/x")).toBe("/x");
  });
});

describe("logs sanitizados", () => {
  it("remove tokens, codes e secrets de strings e objetos", () => {
    const text = redactString("Bearer APP_USR-123-abc code=TG-999 client_secret=xyz refresh TG-555-abc");
    expect(text).not.toMatch(/APP_USR-123|TG-999|xyz|TG-555/);
    const obj = sanitize({ access_token: "a", refresh_token: "b", nested: { client_secret: "c", code: "d", ok: "visivel" } });
    expect(obj).toEqual({ access_token: "[REDACTED]", refresh_token: "[REDACTED]", nested: { client_secret: "[REDACTED]", code: "[REDACTED]", ok: "visivel" } });
  });
});

describe("validação de configuração / HTTPS obrigatório", () => {
  it("rejeita APP_BASE_URL sem HTTPS fora de localhost", () => {
    process.env.APP_BASE_URL = "http://integrador.test";
    process.env.MELI_REDIRECT_URI = "http://integrador.test/api/auth/mercadolivre/callback";
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(ConfigError);
  });

  it("permite http apenas em localhost (desenvolvimento)", () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.MELI_REDIRECT_URI = "http://localhost:3000/api/auth/mercadolivre/callback";
    resetEnvCacheForTests();
    expect(getEnv().secureCookies).toBe(false);
  });

  it("exige MELI_REDIRECT_URI exatamente igual ao callback do app", () => {
    process.env.MELI_REDIRECT_URI = "https://outro.test/api/auth/mercadolivre/callback";
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/MELI_REDIRECT_URI/);
    process.env.MELI_REDIRECT_URI = "https://integrador.test/api/auth/mercadolivre/callback?x=1";
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/MELI_REDIRECT_URI/);
  });

  it("mensagens de erro de configuração não expõem valores", () => {
    delete process.env.MELI_CLIENT_SECRET;
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow("Variáveis de ambiente ausentes: MELI_CLIENT_SECRET");
  });
});
