import { NextRequest } from "next/server";

/** Senha usada apenas nos testes; o hash é gerado em tests/setup.ts. */
export const TEST_PASSWORD = "senha-de-teste-123";

export const BASE = "https://integrador.test";

export function makeRequest(
  path: string,
  init: { method?: string; cookies?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  if (init.cookies) {
    headers.set(
      "cookie",
      Object.entries(init.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(path, BASE), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Resposta fake do fetch para os endpoints do Mercado Livre. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function tokenPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    access_token: "APP_USR-111-ACCESS-AAA-42",
    token_type: "bearer",
    expires_in: 21600,
    scope: "offline_access read write",
    user_id: 42,
    refresh_token: "TG-REFRESH-AAA-42",
    ...overrides,
  };
}
