import "server-only";
import { meliRequest } from "../meli/api";
import IBGE_MUNICIPIOS from "./ibge-municipios.json";

/**
 * Municípios oficiais do IBGE (lista guardada no projeto: src/lib/ads/ibge-municipios.json, 5.571 municípios por UF).
 * Nada é adivinhado: só correspondência exata (sem acento/maiúsculas) e única, ou código confirmado pelo CEP.
 */
const LIST = IBGE_MUNICIPIOS as unknown as Record<string, [number, string][]>;

export interface Municipio {
  code: string;
  name: string;
  uf: string;
}

export const normCity = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function municipiosByUf(uf: string): Municipio[] {
  return (LIST[uf] ?? []).map(([id, name]) => ({ code: String(id), name, uf }));
}

export function municipioByCode(code: string): Municipio | null {
  if (!/^\d{7}$/.test(code)) return null;
  for (const uf of Object.keys(LIST)) {
    const hit = LIST[uf].find(([id]) => String(id) === code);
    if (hit) return { code, name: hit[1], uf };
  }
  return null;
}

export function municipioByName(name: string | null, uf: string | null): Municipio | null {
  if (!name || !uf) return null;
  const n = normCity(name);
  const hits = municipiosByUf(uf).filter((m) => normCity(m.name) === n);
  return hits.length === 1 ? hits[0] : null;
}

const CEP_TIMEOUT_MS = 4_000;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(CEP_TIMEOUT_MS), cache: "no-store", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Fontes de CEP → município. Só o CEP é enviado (nenhum nome ou documento do comprador). */
const CEP_SOURCES: { name: string; resolve: (cep: string, uf: string) => Promise<Municipio | null> }[] = [
  {
    // Mercado Livre (mesma origem dos dados do pedido): devolve nome da cidade e UF.
    name: "Mercado Livre",
    resolve: async (cep, uf) => {
      const r = await meliRequest<{ city?: { name?: string }; state?: { id?: string } }>(`/countries/BR/zip_codes/${cep}`, { auth: "optional", timeoutMs: CEP_TIMEOUT_MS });
      const stateUf = String(r.data?.state?.id ?? "").replace(/^BR-/, "");
      if (stateUf && stateUf !== uf) return null;
      return municipioByName(r.data?.city?.name ?? null, uf);
    },
  },
  {
    name: "BrasilAPI",
    resolve: async (cep) => municipioByCode(String(((await getJson(`https://brasilapi.com.br/api/cep/v1/${cep}`)).ibge as { city?: unknown } | undefined)?.city ?? "")),
  },
  {
    name: "ViaCEP",
    resolve: async (cep) => municipioByCode(String((await getJson(`https://viacep.com.br/ws/${cep}/json/`)).ibge ?? "")),
  },
];

/**
 * Município pelo CEP: consulta as fontes em paralelo e usa a primeira resposta válida
 * (código existente na lista oficial e da mesma UF do endereço). Sem resposta válida → null.
 */
export async function municipioByCep(cep: string | null, uf: string | null): Promise<(Municipio & { via: string }) | null> {
  if (!cep || !/^\d{8}$/.test(cep) || !uf) return null;
  const attempts = CEP_SOURCES.map(async (s) => {
    const m = await s.resolve(cep, uf);
    if (!m || m.uf !== uf) throw new Error("sem resultado");
    return { ...m, via: s.name };
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}
