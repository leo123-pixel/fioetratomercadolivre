"use client";

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T & { error?: string; message?: string; detail?: string; issues?: { path: string; message: string }[] };
}

/** fetch para as rotas internas. Em 401 leva ao login preservando a página atual. */
export async function api<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  const data = (await res.json().catch(() => ({}))) as ApiResult<T>["data"];
  return { ok: res.ok, status: res.status, data };
}

export function errorText(r: ApiResult): string {
  const d = r.data;
  const parts = [d.message ?? `Erro ${r.status}`];
  if (d.detail) parts.push(d.detail);
  if (d.issues?.length) parts.push(d.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
  return parts.join(" — ");
}
