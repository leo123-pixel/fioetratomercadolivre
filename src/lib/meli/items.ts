import "server-only";
import { MeliHttpError, meliRequest } from "./api";
import { withReadRetry } from "../marketplace/errors";

/**
 * Leitura de vários anúncios. Usa o multiget (GET /items?ids=) enquanto o Mercado Livre aceitar; quando ele responde
 * 403 "Resource deprecated - client no longer allowed to consume this resource" (desligamento gradual do recurso),
 * passa a ler um anúncio por vez (GET /items/{id}) e mantém o formato do multiget: [{ code, body }].
 */
const FALLBACK_TTL_MS = 60 * 60 * 1000;
const PARALLEL = 5;
let multigetBlockedUntil = 0;

export function isDeprecatedResource(err: unknown): boolean {
  return err instanceof MeliHttpError && err.status === 403 && /deprecated|no longer allowed/i.test(err.message);
}

/** Só para testes. */
export function resetMultigetFallback(): void {
  multigetBlockedUntil = 0;
}

export async function multigetItems<E extends { code: number; body: unknown }>(ids: string[], attributes: string): Promise<E[]> {
  if (!ids.length) return [];
  if (Date.now() >= multigetBlockedUntil) {
    try {
      const { data } = await withReadRetry(() => meliRequest<E[]>("/items", { auth: true, query: { ids: ids.join(","), attributes } }));
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (!isDeprecatedResource(err)) throw err;
      multigetBlockedUntil = Date.now() + FALLBACK_TTL_MS;
    }
  }
  const out: E[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i];
      try {
        const { data } = await withReadRetry(() => meliRequest<unknown>(`/items/${encodeURIComponent(id)}`, { auth: true, query: { attributes } }));
        out[i] = { code: 200, body: data } as E;
      } catch (err) {
        if (err instanceof MeliHttpError && err.kind === "not_found") out[i] = { code: 404, body: { id, message: "not_found" } } as E;
        else throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
  return out;
}
