import { describe, expect, it } from "vitest";
import { CryptoContext, decryptSecret } from "@/lib/crypto";
import { getValidAccessToken, MeliAuthError } from "@/lib/meli/tokens";
import { jsonResponse, tokenPayload } from "./helpers/fixtures";
import { memoryStore } from "./helpers/memory-store";
import { mockMeli } from "./helpers/meli-mock";
import { seedConnection } from "./helpers/seed";

const HOUR = 60 * 60 * 1000;
const noSleep = { sleep: () => new Promise<void>((r) => setTimeout(r, 1)) };

describe("8. renovação e rotação do Refresh Token", () => {
  it("usa o Access Token armazenado enquanto válido, sem chamar o ML", async () => {
    await seedConnection({ expiresInMs: 2 * HOUR });
    const meli = mockMeli({});
    const token = await getValidAccessToken();
    expect(token.accessToken).toBe("APP_USR-OLD-ACCESS-42");
    expect(meli.calls).toHaveLength(0);
  });

  it("renova antes de usar um token expirado e persiste o novo Refresh Token (rotação)", async () => {
    const conn = await seedConnection({ expiresInMs: -1000 });
    const meli = mockMeli({
      token: () => jsonResponse(tokenPayload({ access_token: "APP_USR-NEW-ACCESS-42", refresh_token: "TG-NEW-REFRESH-42" })),
    });

    const token = await getValidAccessToken();
    expect(token.accessToken).toBe("APP_USR-NEW-ACCESS-42");

    const [call] = meli.tokenCalls();
    expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(call.body!))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "TG-OLD-REFRESH-42",
      client_id: "1234567890",
      client_secret: "test-client-secret",
    });

    const updated = (await memoryStore().getConnectionById(conn.id))!;
    expect(decryptSecret(updated.refreshTokenEnc!, CryptoContext.refreshToken("42"))).toBe("TG-NEW-REFRESH-42");
    expect(decryptSecret(updated.accessTokenEnc!, CryptoContext.accessToken("42"))).toBe("APP_USR-NEW-ACCESS-42");
    expect(updated.tokenVersion).toBe(conn.tokenVersion + 1);
    expect(updated.refreshLockId).toBeNull();
    expect(updated.lastRefreshedAt).not.toBeNull();
  });

  it("renova quando faltam menos de 5 minutos para expirar", async () => {
    await seedConnection({ expiresInMs: 2 * 60 * 1000 });
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload({ access_token: "APP_USR-NEW" })) });
    expect((await getValidAccessToken()).accessToken).toBe("APP_USR-NEW");
    expect(meli.tokenCalls()).toHaveLength(1);
  });

  it("a próxima renovação usa o refresh token rotacionado, nunca o antigo", async () => {
    await seedConnection({ expiresInMs: -1000 });
    let n = 0;
    const meli = mockMeli({
      token: () => {
        n++;
        return jsonResponse(tokenPayload({ access_token: `APP_USR-${n}`, refresh_token: `TG-ROT-${n}`, expires_in: 0 }));
      },
    });
    await getValidAccessToken();
    await getValidAccessToken();
    const used = meli.tokenCalls().map((c) => new URLSearchParams(c.body!).get("refresh_token"));
    expect(used).toEqual(["TG-OLD-REFRESH-42", "TG-ROT-1"]);
  });

  it("chamadas concorrentes resultam em UMA única renovação", async () => {
    await seedConnection({ expiresInMs: -1000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const meli = mockMeli({
      token: async () => {
        await gate;
        return jsonResponse(tokenPayload({ access_token: "APP_USR-ONCE", refresh_token: "TG-ONCE" }));
      },
    });

    const pending = Array.from({ length: 8 }, () => getValidAccessToken(noSleep));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(pending);

    expect(meli.tokenCalls()).toHaveLength(1);
    expect(new Set(results.map((r) => r.accessToken))).toEqual(new Set(["APP_USR-ONCE"]));
  });

  it("respeita lease de outra instância e relê o token já renovado", async () => {
    const conn = await seedConnection({ expiresInMs: -1000 });
    const store = memoryStore();
    // Outra instância detém o lease.
    expect(await store.tryAcquireRefreshLock(conn.id, "outra-instancia", new Date(Date.now() + 60_000), new Date())).toBe(true);
    const meli = mockMeli({ token: () => jsonResponse(tokenPayload()) });

    const waiting = getValidAccessToken(noSleep);
    await new Promise((r) => setTimeout(r, 10));
    const { encryptSecret } = await import("@/lib/crypto");
    await store.completeRefresh(conn.id, "outra-instancia", {
      accessTokenEnc: encryptSecret("APP_USR-FROM-OTHER", CryptoContext.accessToken("42")),
      refreshTokenEnc: encryptSecret("TG-FROM-OTHER", CryptoContext.refreshToken("42")),
      accessTokenExpiresAt: new Date(Date.now() + 6 * HOUR),
      scope: null,
      refreshedAt: new Date(),
    });

    expect((await waiting).accessToken).toBe("APP_USR-FROM-OTHER");
    expect(meli.tokenCalls()).toHaveLength(0);
  });

  it("refresh token revogado (invalid_grant): marca reautorização e apaga tokens", async () => {
    const conn = await seedConnection({ expiresInMs: -1000 });
    mockMeli({ token: () => jsonResponse({ error: "invalid_grant", error_description: "Error validating grant" }, 400) });

    await expect(getValidAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
    const updated = (await memoryStore().getConnectionById(conn.id))!;
    expect(updated).toMatchObject({ status: "REAUTH_REQUIRED", accessTokenEnc: null, refreshTokenEnc: null, lastErrorCode: "invalid_grant" });
    await expect(getValidAccessToken()).rejects.toBeInstanceOf(MeliAuthError);
  });

  it("falha de rede: não faz retry automático e libera o lease", async () => {
    const conn = await seedConnection({ expiresInMs: -1000 });
    const meli = mockMeli({
      token: () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(getValidAccessToken()).rejects.toMatchObject({ code: "refresh_failed" });
    expect(meli.tokenCalls()).toHaveLength(1);
    const updated = (await memoryStore().getConnectionById(conn.id))!;
    expect(updated.status).toBe("ACTIVE");
    expect(updated.refreshLockId).toBeNull();
    expect(updated.lastErrorCode).toBe("network_error");
  });

  it("desconexão durante a renovação descarta os tokens novos (fencing do lease)", async () => {
    const conn = await seedConnection({ expiresInMs: -1000 });
    mockMeli({
      token: async () => {
        await memoryStore().clearTokens(conn.id);
        return jsonResponse(tokenPayload({ access_token: "APP_USR-LATE" }));
      },
    });
    await expect(getValidAccessToken()).rejects.toMatchObject({ code: "refresh_failed" });
    expect((await memoryStore().getConnectionById(conn.id))!).toMatchObject({ status: "DISCONNECTED", accessTokenEnc: null });
  });

  it("sem conexão: erro not_connected", async () => {
    await expect(getValidAccessToken()).rejects.toMatchObject({ code: "not_connected" });
  });
});
