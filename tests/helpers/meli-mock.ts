import { vi } from "vitest";
import { createSessionToken, sessionCookieName } from "@/lib/auth/admin";
import { jsonResponse } from "./fixtures";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** Substitui o fetch global por um roteador de respostas fake do Mercado Livre. */
export function mockMeli(routes: { token?: Handler; usersMe?: Handler; revoke?: Handler }) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init?.body === null ? null : String(init.body),
    };
    calls.push(call);
    if (url === "https://api.mercadolibre.com/oauth/token" && routes.token) return routes.token(call);
    if (url === "https://api.mercadolibre.com/users/me" && routes.usersMe) return routes.usersMe(call);
    if (/\/users\/\d+\/applications\//.test(url) && routes.revoke) return routes.revoke(call);
    return jsonResponse({ error: "not_mocked", url }, 599);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, tokenCalls: () => calls.filter((c) => c.url.endsWith("/oauth/token")) };
}

export function adminCookies(extra: Record<string, string> = {}): Record<string, string> {
  return { [sessionCookieName()]: createSessionToken(), ...extra };
}
