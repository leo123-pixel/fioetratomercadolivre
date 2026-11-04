import "server-only";
import { ConfigError } from "../env";

export interface AdsEnv {
  baseUrl: string;
  apiKey: string;
  cnpj: string;
  userAgent: string;
  pageSize: number;
  minIntervalMs: number;
  timeoutMs: number;
  retryBaseMs: number;
  branchCnpj: string | null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

/**
 * Configuração da ADS API (Tecdisa). Validada sob demanda e separada de getEnv() para que a
 * ausência destas variáveis nunca afete o OAuth do Mercado Livre. Mensagens citam apenas nomes.
 */
export function getAdsEnv(): AdsEnv {
  const missing = ["ADS_API_KEY", "ADS_CNPJ", "ADS_USER_AGENT"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new ConfigError(`Variáveis de ambiente ausentes: ${missing.join(", ")}`);

  let base: URL;
  try {
    base = new URL((process.env.ADS_API_BASE_URL?.trim() || "https://hom.adsapi.com.br").replace(/\/+$/, ""));
  } catch {
    throw new ConfigError("ADS_API_BASE_URL não é uma URL válida");
  }
  if (base.protocol !== "https:" && !LOCAL_HOSTS.has(base.hostname)) {
    throw new ConfigError("ADS_API_BASE_URL deve usar HTTPS");
  }

  const cnpj = process.env.ADS_CNPJ!.replace(/\D/g, "");
  if (cnpj.length !== 14) throw new ConfigError("ADS_CNPJ deve conter 14 dígitos");

  const branchRaw = process.env.ADS_BRANCH_CNPJ?.replace(/\D/g, "") ?? "";
  if (branchRaw && branchRaw.length !== 14) throw new ConfigError("ADS_BRANCH_CNPJ deve conter 14 dígitos");

  return {
    baseUrl: base.origin + base.pathname.replace(/\/+$/, ""),
    apiKey: process.env.ADS_API_KEY!.trim(),
    cnpj,
    userAgent: process.env.ADS_USER_AGENT!.trim(),
    pageSize: intEnv("ADS_PAGE_SIZE", 50, 1, 500),
    minIntervalMs: intEnv("ADS_MIN_INTERVAL_MS", 300, 0, 10_000),
    timeoutMs: intEnv("ADS_TIMEOUT_MS", 20_000, 1_000, 60_000),
    retryBaseMs: intEnv("ADS_RETRY_BASE_MS", 2_000, 1, 30_000),
    branchCnpj: branchRaw || null,
  };
}
