import "server-only";

/**
 * Parâmetros operacionais das fases 4/5, lidos do ambiente com valores padrão seguros.
 * Nenhum é obrigatório; valores fora do intervalo voltam ao padrão.
 */
function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

export interface MarketplaceConfig {
  /** Intervalo da reconciliação de anúncios (consulta à API). Referência: 5 minutos. */
  listingSyncIntervalMin: number;
  /** Intervalo da recuperação de notificações perdidas (missed_feeds). */
  missedFeedsIntervalMin: number;
  /** Intervalo da varredura de pedidos atualizados recentemente (rede de segurança dos webhooks). */
  ordersRecoveryIntervalMin: number;
  /** Janela da varredura de pedidos (horas para trás). */
  ordersRecoveryWindowHours: number;
  /** Tentativas por evento antes de ir para FAILED (dead-letter). */
  eventMaxAttempts: number;
  /** Retenção do JSON original dos pedidos (LGPD). */
  orderRawRetentionDays: number;
  /** Retenção de eventos concluídos/ignorados. */
  eventRetentionDays: number;
  /** Atraso (minutos) a partir do qual um evento pendente gera alerta. */
  backlogAlertMinutes: number;
  /** IPs de origem aceitos no webhook (vazio = qualquer origem; a autenticidade vem da releitura na API). */
  webhookAllowedIps: string[];
  /** URL opcional que recebe alertas administrativos (POST JSON). */
  alertWebhookUrl: string | null;
}

export function getMarketplaceConfig(): MarketplaceConfig {
  const alert = process.env.ALERT_WEBHOOK_URL?.trim();
  return {
    listingSyncIntervalMin: intEnv("MELI_SYNC_INTERVAL_MINUTES", 5, 1, 1440),
    missedFeedsIntervalMin: intEnv("MELI_MISSED_FEEDS_INTERVAL_MINUTES", 60, 5, 1440),
    ordersRecoveryIntervalMin: intEnv("MELI_ORDERS_RECOVERY_INTERVAL_MINUTES", 30, 5, 1440),
    ordersRecoveryWindowHours: intEnv("MELI_ORDERS_RECOVERY_WINDOW_HOURS", 48, 1, 720),
    eventMaxAttempts: intEnv("MELI_EVENT_MAX_ATTEMPTS", 8, 1, 50),
    orderRawRetentionDays: intEnv("ORDER_RAW_RETENTION_DAYS", 180, 1, 3650),
    eventRetentionDays: intEnv("MELI_EVENT_RETENTION_DAYS", 90, 7, 3650),
    backlogAlertMinutes: intEnv("MELI_BACKLOG_ALERT_MINUTES", 30, 5, 1440),
    webhookAllowedIps: (process.env.MELI_WEBHOOK_ALLOWED_IPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    alertWebhookUrl: alert && /^https:\/\//.test(alert) ? alert : null,
  };
}
