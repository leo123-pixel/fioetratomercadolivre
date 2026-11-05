import "server-only";
import { logger, sanitize } from "../logger";
import type { Sql } from "../sql";
import { getMarketplaceConfig } from "./config";

/**
 * Ponto único de alertas administrativos. Sempre registra em log estruturado (nível error, campo
 * alert) e, se ALERT_WEBHOOK_URL estiver definida (https), envia um POST JSON — pronto para Slack,
 * e-mail transacional ou outro serviço. O último alerta de cada tipo fica em app_settings para o
 * painel de monitoramento. Repetições do mesmo código são suprimidas por 1 hora (por instância).
 */
const recent = new Map<string, number>();
const SUPPRESS_MS = 60 * 60_000;

export async function raiseAlert(sql: Sql | null, code: string, message: string, details: Record<string, unknown> = {}): Promise<void> {
  const now = Date.now();
  if ((recent.get(code) ?? 0) > now - SUPPRESS_MS) return;
  recent.set(code, now);
  logger.error(`ALERTA: ${message}`, { alert: code, ...details });
  if (sql) {
    await sql
      .execute(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('meli_last_alert', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ code, message, at: new Date(now).toISOString() })],
      )
      .catch(() => undefined);
  }
  const url = getMarketplaceConfig().alertWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "fioetrato-integrador", code, message, details: sanitize(details), at: new Date(now).toISOString() }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
  } catch (err) {
    logger.warn("Falha ao enviar alerta administrativo", { code, err });
  }
}

export function resetAlertsForTests() {
  recent.clear();
}
