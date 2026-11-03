import { describe, expect, it } from "vitest";
import { GET as startRoute } from "@/app/api/auth/mercadolivre/route";
import { GET as callbackRoute } from "@/app/api/auth/mercadolivre/callback/route";
import { decryptSecret, CryptoContext, pkceChallengeS256, sha256Hex } from "@/lib/crypto";
import { resetEnvCacheForTests } from "@/lib/env";
import { bindingCookieName, STATE_TTL_MS } from "@/lib/meli/oauth";
import { jsonResponse, makeRequest, tokenPayload } from "./helpers/fixtures";
import { memoryStore } from "./helpers/memory-store";
import { adminCookies, mockMeli } from "./helpers/meli-mock";

const USER_ME = { id: 42, nickname: "FIOETRATO", site_id: "MLB" };

/** Executa o início do fluxo e devolve state, nonce de binding e URL de autorização. */
async function startFlow() {
  const res = await startRoute(makeRequest("/api/auth/mercadolivre", { cookies: adminCookies(), headers: { "sec-fetch-site": "same-origin" } }));
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  const bindingCookie = res.cookies.get(bindingCookieName());
  return { res, location, state: location.searchParams.get("state")!, binding: bindingCookie!.value, bindingCookie };
}

function callback(query: Record<string, string>, cookies: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return callbackRoute(makeRequest(`/api/auth/mercadolivre/callback?${qs}`, { cookies }));
}

function redirectParams(res: Response) {
  const url = new URL(res.headers.get("location")!);
  return { path: url.pathname, status: url.searchParams.get("status"), error: url.searchParams.get("error") };
}

describe("GET /api/auth/mercadolivre (início do OAuth)", () => {
  it("1. gera a URL de autorização com os parâmetros da documentação oficial", async () => {
    const { location, state, bindingCookie } = await startFlow();
    expect(`${location.origin}${location.pathname}`).toBe("https://auth.mercadolivre.com.br/authorization");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("1234567890");
    expect(location.searchParams.get("redirect_uri")).toBe("https://integrador.test/api/auth/mercadolivre/callback");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bindingCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/mercadolivre" });
  });

  it("2. armazena apenas o hash do state, com expiração", async () => {
    const before = Date.now();
    const { state } = await startFlow();
    const stored = memoryStore().states.get(sha256Hex(state))!;
    expect(stored).toBeDefined();
    expect([...memoryStore().states.keys()]).not.toContain(state);
    expect(stored.consumedAt).toBeNull();
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + STATE_TTL_MS - 1000);
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + STATE_TTL_MS);
  });

  it("6. PKCE habilitado: envia code_challenge S256 derivado do verifier guardado criptografado", async () => {
    const { location, state } = await startFlow();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const stored = memoryStore().states.get(sha256Hex(state))!;
    const verifier = decryptSecret(stored.codeVerifierEnc!, CryptoContext.pkceVerifier);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(location.searchParams.get("code_challenge")).toBe(pkceChallengeS256(verifier));
    expect(stored.codeVerifierEnc).not.toContain(verifier);
  });

  it("PKCE desabilitado: não envia code_challenge", async () => {
    process.env.MELI_PKCE_ENABLED = "false";
    resetEnvCacheForTests();
    const { location, state } = await startFlow();
    expect(location.searchParams.has("code_challenge")).toBe(false);
    expect(memoryStore().states.get(sha256Hex(state))!.codeVerifierEnc).toBeNull();
  });

  it("9. sem sessão de administrador redireciona ao login e não cria state", async () => {
    const res = await startRoute(makeRequest("/api/auth/mercadolivre"));
    expect(res.status).toBe(303);
    expect(redirectParams(res).path).toBe("/login");
    expect(memoryStore().states.size).toBe(0);
  });

  it("9. sessão forjada (assinatura inválida) é rejeitada", async () => {
    const res = await startRoute(makeRequest("/api/auth/mercadolivre", { cookies: { "__Host-ft_admin": "eyJzaWQiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5fQ.assinatura" } }));
    expect(redirectParams(res).path).toBe("/login");
  });

  it("bloqueia início disparado por outro site (Sec-Fetch-Site: cross-site)", async () => {
    const res = await startRoute(makeRequest("/api/auth/mercadolivre", { cookies: adminCookies(), headers: { "sec-fetch-site": "cross-site" } }));
    expect(redirectParams(res).error).toBe("forbidden");
    expect(memoryStore().states.size).toBe(0);
  });
});

describe("GET /api/auth/mercadolivre/callback", () => {
  it("5/6/7/10. troca o code (form-urlencoded + code_verifier), confirma /users/me e guarda tokens criptografados", async () => {
    const { state, binding } = await startFlow();
    const verifier = decryptSecret(memoryStore().states.get(sha256Hex(state))!.codeVerifierEnc!, CryptoContext.pkceVerifier);
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()), usersMe: () => jsonResponse(USER_ME) });

    const res = await callback({ code: "TG-AUTHCODE-1", state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res)).toEqual({ path: "/configuracoes/integracoes/mercadolivre", status: "connected", error: null });
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.cookies.get(bindingCookieName())?.maxAge).toBe(0);

    const [tokenCall, meCall] = meli.calls;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenCall.body!);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "TG-AUTHCODE-1",
      redirect_uri: "https://integrador.test/api/auth/mercadolivre/callback",
      code_verifier: verifier,
      client_id: "1234567890",
      client_secret: "test-client-secret",
    });
    expect(meCall.url).toBe("https://api.mercadolibre.com/users/me");
    expect(meCall.headers.get("authorization")).toBe("Bearer APP_USR-111-ACCESS-AAA-42");

    const conn = (await memoryStore().getCurrentConnection())!;
    expect(conn).toMatchObject({ meliUserId: "42", nickname: "FIOETRATO", siteId: "MLB", status: "ACTIVE" });
    const serialized = JSON.stringify(conn);
    expect(serialized).not.toContain("APP_USR-111-ACCESS-AAA-42");
    expect(serialized).not.toContain("TG-REFRESH-AAA-42");
    expect(decryptSecret(conn.accessTokenEnc!, CryptoContext.accessToken("42"))).toBe("APP_USR-111-ACCESS-AAA-42");
    expect(decryptSecret(conn.refreshTokenEnc!, CryptoContext.refreshToken("42"))).toBe("TG-REFRESH-AAA-42");
    expect(conn.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 21000 * 1000);
  });

  it("3. rejeita state reutilizado (uso único)", async () => {
    const { state, binding } = await startFlow();
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()), usersMe: () => jsonResponse(USER_ME) });
    const cookies = adminCookies({ [bindingCookieName()]: binding });
    expect(redirectParams(await callback({ code: "TG-1", state }, cookies)).status).toBe("connected");
    expect(redirectParams(await callback({ code: "TG-2", state }, cookies)).error).toBe("invalid_state");
    expect(meli.tokenCalls()).toHaveLength(1);
  });

  it("3. rejeita state expirado", async () => {
    const { state, binding } = await startFlow();
    memoryStore().states.get(sha256Hex(state))!.expiresAt = new Date(Date.now() - 1000);
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()) });
    const res = await callback({ code: "TG-1", state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res).error).toBe("invalid_state");
    expect(meli.calls).toHaveLength(0);
  });

  it("3. rejeita state desconhecido/forjado", async () => {
    await startFlow();
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()) });
    const res = await callback({ code: "TG-1", state: "state-forjado" }, adminCookies({ [bindingCookieName()]: "qualquer" }));
    expect(redirectParams(res).error).toBe("invalid_state");
    expect(meli.calls).toHaveLength(0);
  });

  it("3. rejeita state válido vindo de outro navegador (cookie de binding ausente ou diferente)", async () => {
    const { state } = await startFlow();
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()) });
    expect(redirectParams(await callback({ code: "TG-1", state }, adminCookies())).error).toBe("invalid_state");
    expect(redirectParams(await callback({ code: "TG-1", state }, adminCookies({ [bindingCookieName()]: "outro" }))).error).toBe("invalid_state");
    expect(meli.calls).toHaveLength(0);
  });

  it("rejeita callback sem state", async () => {
    const res = await callback({ code: "TG-1" }, adminCookies());
    expect(redirectParams(res).error).toBe("missing_state");
  });

  it("4. trata ausência do code (e consome o state)", async () => {
    const { state, binding } = await startFlow();
    const meli = mockMeli({});
    const res = await callback({ state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res).error).toBe("missing_code");
    expect(meli.calls).toHaveLength(0);
    expect(memoryStore().states.get(sha256Hex(state))!.consumedAt).not.toBeNull();
  });

  it("trata erro de autorização retornado pelo Mercado Livre", async () => {
    const { state, binding } = await startFlow();
    const res = await callback({ error: "access_denied", state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res).error).toBe("access_denied");
  });

  it("9. callback sem sessão de administrador não troca o code nem consome o state", async () => {
    const { state, binding } = await startFlow();
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()) });
    const res = await callback({ code: "TG-1", state }, { [bindingCookieName()]: binding });
    expect(redirectParams(res).error).toBe("unauthorized");
    expect(meli.calls).toHaveLength(0);
    expect(memoryStore().states.get(sha256Hex(state))!.consumedAt).toBeNull();
  });

  it("falha na troca do code (invalid_grant) não salva conexão", async () => {
    const { state, binding } = await startFlow();
    mockMeli({ token: () => jsonResponse({ error: "invalid_grant", status: 400 }, 400) });
    const res = await callback({ code: "TG-1", state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res).error).toBe("token_exchange_failed");
    expect(memoryStore().connections.size).toBe(0);
  });

  it("10. user_id do token diferente de /users/me: não salva tokens", async () => {
    const { state, binding } = await startFlow();
    mockMeli({ token: () => jsonResponse(tokenPayload()), usersMe: () => jsonResponse({ ...USER_ME, id: 999 }) });
    const res = await callback({ code: "TG-1", state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res).error).toBe("account_verification_failed");
    expect(memoryStore().connections.size).toBe(0);
  });

  it("10. falha em /users/me: não salva tokens", async () => {
    const { state, binding } = await startFlow();
    mockMeli({ token: () => jsonResponse(tokenPayload()), usersMe: () => jsonResponse({ message: "invalid_token" }, 401) });
    const res = await callback({ code: "TG-1", state }, adminCookies({ [bindingCookieName()]: binding }));
    expect(redirectParams(res).error).toBe("account_verification_failed");
    expect(memoryStore().connections.size).toBe(0);
  });

  it("nunca registra tokens, code ou secret nos logs", async () => {
    const { state, binding } = await startFlow();
    mockMeli({ token: () => jsonResponse(tokenPayload()), usersMe: () => jsonResponse(USER_ME) });
    await callback({ code: "TG-AUTHCODE-SECRETO", state }, adminCookies({ [bindingCookieName()]: binding }));
    const logged = [console.info, console.warn, console.error]
      .flatMap((fn) => (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls)
      .map((args) => args.join(" "))
      .join("\n");
    expect(logged).toContain("Conta Mercado Livre conectada");
    for (const secret of ["TG-AUTHCODE-SECRETO", "APP_USR-111-ACCESS-AAA-42", "TG-REFRESH-AAA-42", "test-client-secret", state]) {
      expect(logged).not.toContain(secret);
    }
  });
});
