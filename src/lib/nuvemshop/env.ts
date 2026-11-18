import "server-only";
import { ConfigError, getEnv } from "../env";

/**
 * Configuração da integração Nuvemshop (Fase 1 — somente leitura). Lida sob demanda (não no import),
 * para que o build e o restante do sistema não dependam destas variáveis. Mensagens de erro citam só
 * nomes de variáveis, nunca valores.
 *
 *   NUVEMSHOP_APP_ID         ID do aplicativo no Portal de Parceiros (é o client_id do OAuth).
 *   NUVEMSHOP_CLIENT_SECRET  Segredo do aplicativo (somente servidor).
 *   NUVEMSHOP_REDIRECT_URI   Deve ser exatamente <APP_BASE_URL>/api/auth/nuvemshop/callback e igual ao
 *                            "URL de redirecionamento" cadastrado no aplicativo.
 *   NUVEMSHOP_USER_AGENT     Opcional. Identificação obrigatória pela API: "Nome (url ou e-mail)".
 *   NUVEMSHOP_API_BASE_URL   Opcional. Padrão https://api.tiendanube.com/2025-03 (versão estável).
 *   NUVEMSHOP_AUTH_BASE_URL  Opcional. Padrão https://www.nuvemshop.com.br (equivalente a tiendanube.com).
 */
export const NUVEMSHOP_CALLBACK_PATH = "/api/auth/nuvemshop/callback";
export const NUVEMSHOP_API_VERSION = "2025-03";
const DEFAULT_API_BASE = `https://api.tiendanube.com/${NUVEMSHOP_API_VERSION}`;
const DEFAULT_AUTH_BASE = "https://www.nuvemshop.com.br";
const ALLOWED_API_HOSTS = new Set(["api.tiendanube.com", "api.nuvemshop.com.br"]);
const ALLOWED_AUTH_HOSTS = new Set(["www.tiendanube.com", "www.nuvemshop.com.br"]);

export interface NuvemshopEnv {
  appId: string;
  clientSecret: string;
  redirectUri: string;
  userAgent: string;
  apiBaseUrl: string;
  authBaseUrl: string;
}

/** Os escopos são definidos no aplicativo (Portal de Parceiros), não na URL de autorização. */
export const REQUIRED_SCOPES_PHASE1 = ["read_products", "read_locations"] as const;

function optionalUrl(name: string, fallback: string, allowed: Set<string>): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} não é uma URL válida`);
  }
  if (url.protocol !== "https:" || !allowed.has(url.hostname)) {
    throw new ConfigError(`${name} deve ser HTTPS em um domínio oficial da Nuvemshop`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function isNuvemshopConfigured(): boolean {
  return Boolean(process.env.NUVEMSHOP_APP_ID?.trim() && process.env.NUVEMSHOP_CLIENT_SECRET?.trim() && process.env.NUVEMSHOP_REDIRECT_URI?.trim());
}

export function getNuvemshopEnv(): NuvemshopEnv {
  const base = getEnv();
  const missing = ["NUVEMSHOP_APP_ID", "NUVEMSHOP_CLIENT_SECRET", "NUVEMSHOP_REDIRECT_URI"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new ConfigError(`Variáveis de ambiente ausentes: ${missing.join(", ")}`);
  const appId = process.env.NUVEMSHOP_APP_ID!.trim();
  if (!/^\d{1,20}$/.test(appId)) throw new ConfigError("NUVEMSHOP_APP_ID deve ser o ID numérico do aplicativo");
  let redirect: URL;
  try {
    redirect = new URL(process.env.NUVEMSHOP_REDIRECT_URI!.trim());
  } catch {
    throw new ConfigError("NUVEMSHOP_REDIRECT_URI não é uma URL válida");
  }
  // O callback precisa cair na mesma origem do app para ler os cookies de sessão e de binding do state.
  if (redirect.origin !== base.appOrigin || redirect.pathname !== NUVEMSHOP_CALLBACK_PATH || redirect.search || redirect.hash) {
    throw new ConfigError(`NUVEMSHOP_REDIRECT_URI deve ser exatamente ${base.appOrigin}${NUVEMSHOP_CALLBACK_PATH}`);
  }
  const ua = process.env.NUVEMSHOP_USER_AGENT?.trim() || `Lopes Integrador (${base.appOrigin})`;
  if (!/\(.+\)/.test(ua) || ua.length > 200) throw new ConfigError('NUVEMSHOP_USER_AGENT deve seguir o formato "Nome (url ou e-mail)"');
  return {
    appId,
    clientSecret: process.env.NUVEMSHOP_CLIENT_SECRET!.trim(),
    redirectUri: redirect.toString(),
    userAgent: ua,
    apiBaseUrl: optionalUrl("NUVEMSHOP_API_BASE_URL", DEFAULT_API_BASE, ALLOWED_API_HOSTS),
    authBaseUrl: optionalUrl("NUVEMSHOP_AUTH_BASE_URL", DEFAULT_AUTH_BASE, ALLOWED_AUTH_HOSTS),
  };
}
