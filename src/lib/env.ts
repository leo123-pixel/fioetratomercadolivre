import "server-only";

export const CALLBACK_PATH = "/api/auth/mercadolivre/callback";

export interface AppEnv {
  MELI_CLIENT_ID: string;
  MELI_CLIENT_SECRET: string;
  MELI_REDIRECT_URI: string;
  MELI_PKCE_ENABLED: boolean;
  TOKEN_ENCRYPTION_KEY: string;
  APP_BASE_URL: string;
  ADMIN_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  /** true quando APP_BASE_URL é https (cookies Secure / prefixos __Host- e __Secure-). */
  secureCookies: boolean;
  appOrigin: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED = [
  "MELI_CLIENT_ID",
  "MELI_CLIENT_SECRET",
  "MELI_REDIRECT_URI",
  "TOKEN_ENCRYPTION_KEY",
  "APP_BASE_URL",
  "ADMIN_PASSWORD_HASH",
  "SESSION_SECRET",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

let cached: AppEnv | null = null;

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigError(`${name} não é uma URL válida`);
  }
}

/** HTTPS obrigatório fora de localhost. */
function assertHttps(name: string, url: URL) {
  if (url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ConfigError(`${name} deve usar HTTPS no ambiente publicado`);
  }
}

/**
 * Lê e valida as variáveis de ambiente sob demanda (não no import), para que o build
 * não dependa de segredos. As mensagens de erro citam apenas nomes, nunca valores.
 */
export function getEnv(): AppEnv {
  if (cached) return cached;

  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Variáveis de ambiente ausentes: ${missing.join(", ")}`);
  }
  const read = (key: (typeof REQUIRED)[number]) => process.env[key]!.trim();

  const appBase = parseUrl("APP_BASE_URL", read("APP_BASE_URL").replace(/\/+$/, ""));
  const redirect = parseUrl("MELI_REDIRECT_URI", read("MELI_REDIRECT_URI"));
  assertHttps("APP_BASE_URL", appBase);
  assertHttps("MELI_REDIRECT_URI", redirect);

  // O callback precisa cair na mesma origem do app para ler os cookies de sessão/binding.
  if (redirect.origin !== appBase.origin || redirect.pathname !== CALLBACK_PATH || redirect.search || redirect.hash) {
    throw new ConfigError(`MELI_REDIRECT_URI deve ser exatamente ${appBase.origin}${CALLBACK_PATH}`);
  }

  const key = Buffer.from(read("TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new ConfigError("TOKEN_ENCRYPTION_KEY deve conter 32 bytes codificados em base64");
  }
  if (read("SESSION_SECRET").length < 32) {
    throw new ConfigError("SESSION_SECRET deve ter pelo menos 32 caracteres");
  }
  if (!read("ADMIN_PASSWORD_HASH").startsWith("scrypt$")) {
    throw new ConfigError("ADMIN_PASSWORD_HASH inválido (gere com npm run admin:hash)");
  }

  cached = {
    MELI_CLIENT_ID: read("MELI_CLIENT_ID"),
    MELI_CLIENT_SECRET: read("MELI_CLIENT_SECRET"),
    MELI_REDIRECT_URI: redirect.toString(),
    MELI_PKCE_ENABLED: (process.env.MELI_PKCE_ENABLED ?? "true").trim().toLowerCase() !== "false",
    TOKEN_ENCRYPTION_KEY: read("TOKEN_ENCRYPTION_KEY"),
    APP_BASE_URL: appBase.origin,
    ADMIN_PASSWORD_HASH: read("ADMIN_PASSWORD_HASH"),
    SESSION_SECRET: read("SESSION_SECRET"),
    secureCookies: appBase.protocol === "https:",
    appOrigin: appBase.origin,
  };
  return cached;
}

export function resetEnvCacheForTests() {
  cached = null;
}
