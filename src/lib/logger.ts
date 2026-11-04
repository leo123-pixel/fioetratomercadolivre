import "server-only";

/** Chaves cujo valor nunca deve aparecer em log. */
const SENSITIVE_KEY = /(token|secret|password|verifier|authorization|cookie|api[-_]?key|service[-_]?role|^apikey$|^code$|^state$)/i;

/** Padrões de credenciais do Mercado Livre que podem vazar dentro de mensagens livres. */
const REDACTED = "[REDACTED]";

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(client_secret|refresh_token|access_token|code_verifier|code|state)=([^&\s"]+)/gi, `$1=${REDACTED}`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/APP_USR-[A-Za-z0-9-]+/g, REDACTED],
  [/\bTG-[A-Za-z0-9-]+/g, REDACTED],
];

export function redactString(value: string): string {
  return SENSITIVE_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value);
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MaxDepth]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : sanitize(val, depth + 1)]),
    );
  }
  return value;
}

type Level = "info" | "warn" | "error";

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  const entry = { level, time: new Date().toISOString(), message: redactString(message), ...(meta ? { meta: sanitize(meta) } : {}) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
