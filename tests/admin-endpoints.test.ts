import { describe, expect, it } from "vitest";
import { POST as loginRoute } from "@/app/api/admin/login/route";
import { GET as connectionRoute } from "@/app/api/mercadolivre/connection/route";
import { POST as testRoute } from "@/app/api/mercadolivre/connection/test/route";
import { POST as disconnectRoute } from "@/app/api/mercadolivre/disconnect/route";
import { createSessionToken, sessionCookieName, verifySessionToken } from "@/lib/auth/admin";
import { BASE, jsonResponse, makeRequest, TEST_PASSWORD, tokenPayload } from "./helpers/fixtures";
import { memoryStore } from "./helpers/memory-store";
import { adminCookies, mockMeli } from "./helpers/meli-mock";
import { seedConnection } from "./helpers/seed";

const SAME_ORIGIN = { origin: BASE };

describe("9. bloqueio de acesso não autorizado", () => {
  it("GET /api/mercadolivre/connection exige sessão", async () => {
    const res = await connectionRoute(makeRequest("/api/mercadolivre/connection"));
    expect(res.status).toBe(401);
  });

  it("sessão expirada é rejeitada", async () => {
    const expired = createSessionToken(Date.now() - 9 * 60 * 60 * 1000);
    const res = await connectionRoute(makeRequest("/api/mercadolivre/connection", { cookies: { [sessionCookieName()]: expired } }));
    expect(res.status).toBe(401);
  });

  it("POST /api/mercadolivre/disconnect exige sessão", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const res = await disconnectRoute(makeRequest("/api/mercadolivre/disconnect", { method: "POST", headers: SAME_ORIGIN, body: { confirm: "DESCONECTAR" } }));
    expect(res.status).toBe(401);
    expect((await memoryStore().getCurrentConnection())!.status).toBe("ACTIVE");
  });

  it("POST /api/mercadolivre/disconnect rejeita outra origem (CSRF)", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const res = await disconnectRoute(
      makeRequest("/api/mercadolivre/disconnect", {
        method: "POST",
        cookies: adminCookies(),
        headers: { origin: "https://atacante.example" },
        body: { confirm: "DESCONECTAR" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await memoryStore().getCurrentConnection())!.status).toBe("ACTIVE");
  });

  it("POST /api/mercadolivre/connection/test exige sessão", async () => {
    const res = await testRoute(makeRequest("/api/mercadolivre/connection/test", { method: "POST", headers: SAME_ORIGIN }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/mercadolivre/connection", () => {
  it("retorna somente dados não sensíveis", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const res = await connectionRoute(makeRequest("/api/mercadolivre/connection", { cookies: adminCookies() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(
      ["accessTokenExpiresAt", "lastConnectedAt", "lastErrorCode", "lastRefreshedAt", "meliUserId", "nickname", "siteId", "status"].sort(),
    );
    expect(body).toMatchObject({ status: "connected", meliUserId: "42", nickname: "FIOETRATO" });
    expect(text).not.toMatch(/APP_USR|TG-|v1\./);
  });

  it("sem conta conectada retorna status disconnected", async () => {
    const res = await connectionRoute(makeRequest("/api/mercadolivre/connection", { cookies: adminCookies() }));
    expect(await res.json()).toMatchObject({ status: "disconnected", meliUserId: null });
  });
});

describe("POST /api/mercadolivre/connection/test", () => {
  it("10. faz chamada autenticada a /users/me com o token armazenado", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const meli = mockMeli({ usersMe: () => jsonResponse({ id: 42, nickname: "FIOETRATO", site_id: "MLB" }) });
    const res = await testRoute(makeRequest("/api/mercadolivre/connection/test", { method: "POST", cookies: adminCookies(), headers: SAME_ORIGIN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, meliUserId: "42", nickname: "FIOETRATO" });
    expect(meli.calls[0].headers.get("authorization")).toBe("Bearer APP_USR-OLD-ACCESS-42");
  });

  it("renova o token expirado antes da chamada a /users/me", async () => {
    await seedConnection({ expiresInMs: -1 });
    const meli = mockMeli({
      token: () => jsonResponse(tokenPayload({ access_token: "APP_USR-FRESH" })),
      usersMe: () => jsonResponse({ id: 42, nickname: "FIOETRATO", site_id: "MLB" }),
    });
    const res = await testRoute(makeRequest("/api/mercadolivre/connection/test", { method: "POST", cookies: adminCookies(), headers: SAME_ORIGIN }));
    expect(res.status).toBe(200);
    expect(meli.calls.map((c) => c.url)).toEqual(["https://api.mercadolibre.com/oauth/token", "https://api.mercadolibre.com/users/me"]);
    expect(meli.calls[1].headers.get("authorization")).toBe("Bearer APP_USR-FRESH");
  });

  it("sem conexão retorna 409 not_connected", async () => {
    const res = await testRoute(makeRequest("/api/mercadolivre/connection/test", { method: "POST", cookies: adminCookies(), headers: SAME_ORIGIN }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_connected");
  });
});

describe("POST /api/mercadolivre/disconnect", () => {
  it("exige confirmação explícita", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const res = await disconnectRoute(makeRequest("/api/mercadolivre/disconnect", { method: "POST", cookies: adminCookies(), headers: SAME_ORIGIN, body: {} }));
    expect(res.status).toBe(400);
    expect((await memoryStore().getCurrentConnection())!.status).toBe("ACTIVE");
  });

  it("revoga no ML e apaga os tokens locais", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    const meli = mockMeli({ revoke: () => new Response(null, { status: 200 }) });
    const res = await disconnectRoute(
      makeRequest("/api/mercadolivre/disconnect", { method: "POST", cookies: adminCookies(), headers: SAME_ORIGIN, body: { confirm: "DESCONECTAR" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, hadConnection: true, revokedRemotely: true });
    expect(meli.calls[0]).toMatchObject({ method: "DELETE", url: "https://api.mercadolibre.com/users/42/applications/1234567890" });
    expect((await memoryStore().getCurrentConnection())!).toMatchObject({ status: "DISCONNECTED", accessTokenEnc: null, refreshTokenEnc: null });
  });

  it("se a revogação remota falhar, ainda remove os tokens locais e informa a limitação", async () => {
    await seedConnection({ expiresInMs: 3600_000 });
    mockMeli({ revoke: () => jsonResponse({ message: "forbidden" }, 403) });
    const res = await disconnectRoute(
      makeRequest("/api/mercadolivre/disconnect", { method: "POST", cookies: adminCookies(), headers: SAME_ORIGIN, body: { confirm: "DESCONECTAR" } }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, revokedRemotely: false });
    expect(body.note).toContain("não foi confirmada");
    expect((await memoryStore().getCurrentConnection())!.refreshTokenEnc).toBeNull();
  });
});

describe("POST /api/admin/login", () => {
  const login = (password: string, headers: Record<string, string> = SAME_ORIGIN) =>
    loginRoute(makeRequest("/api/admin/login", { method: "POST", headers: { ...headers, "x-forwarded-for": "203.0.113.7" }, body: { password } }));

  it("senha correta define cookie HttpOnly/Secure/SameSite=Lax válido", async () => {
    const res = await login(TEST_PASSWORD);
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(sessionCookieName())!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(sessionCookieName()).toBe("__Host-ft_admin");
    expect(verifySessionToken(cookie.value)).not.toBeNull();
  });

  it("senha incorreta retorna 401 sem cookie", async () => {
    const res = await login("errada");
    expect(res.status).toBe(401);
    expect(res.cookies.get(sessionCookieName())).toBeUndefined();
  });

  it("bloqueia após 5 tentativas inválidas", async () => {
    for (let i = 0; i < 5; i++) expect((await login("errada")).status).toBe(401);
    expect((await login(TEST_PASSWORD)).status).toBe(429);
  });

  it("rejeita login de outra origem", async () => {
    expect((await login(TEST_PASSWORD, { origin: "https://atacante.example" })).status).toBe(403);
  });
});
