import { ADS_TIMEZONE, adsHoursLabel, adsHoursState } from "./ads/hours";
import { listOrders, type OrderListItem } from "./marketplace/orders";
import { getConnectionSummary } from "./meli/connection";
import type { Sql } from "./sql";
import { LEGACY_FILTERS, listLegacyListings, type LegacyFilter } from "./stock/legacy";
import { autoPriceState, getPriceSettings, listPriceApplications, type PriceProposalView } from "./stock/prices";
import { listJobs, type JobView } from "./stock/reconcile";
import { autoSyncState, getStockSettings } from "./stock/settings";

/** Painel inicial da área administrativa: tudo somente leitura, num único carregamento. */

export interface SalesDay {
  day: string; // YYYY-MM-DD no horário de Campo Grande/MS
  orders: number;
  amount: number;
}

export interface DashboardData {
  generatedAt: string;
  sales: { days: SalesDay[]; today: SalesDay; last7: { orders: number; amount: number }; prev7: { orders: number; amount: number } };
  orders: { counts: Record<string, number>; recent: OrderListItem[] };
  listings: { counts: Record<LegacyFilter, number>; active: number; paused: number; closed: number };
  products: number;
  stock: { appliedToday: number; problemsToday: number; queued: number; recent: JobView[] };
  price: { appliedToday: number; recent: PriceProposalView[] };
  automation: {
    stock: { active: boolean; reason: string | null; intervalMin: number };
    price: { active: boolean; reason: string | null; intervalMin: number };
    adsHours: { open: boolean; reason: string | null; label: string };
  };
  connection: Awaited<ReturnType<typeof getConnectionSummary>>;
  lastTickAt: string | null;
  lastAlert: { message: string; at: string } | null;
  events: { pending: number; failed: number };
}

const TZ = ADS_TIMEZONE;
const num = (v: unknown) => Number(v ?? 0) || 0;

export async function getDashboard(sql: Sql): Promise<DashboardData> {
  const stockSettings = await getStockSettings(sql);
  const [salesRows, ordersPage, legacy, listingStatus, products, stockToday, priceToday, stockRecent, priceRecent, priceSettings, settingsRows, events, connection] =
    await Promise.all([
      sql.query<{ day: string; orders: number; amount: string }>(
        `WITH days AS (
           SELECT generate_series((now() AT TIME ZONE $1::text)::date - 13, (now() AT TIME ZONE $1::text)::date, interval '1 day')::date AS day
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(o.id)::int AS orders, COALESCE(sum(o.total_amount), 0)::text AS amount
         FROM days d
         LEFT JOIN marketplace_order_inbox o
           ON (o.date_created AT TIME ZONE $1::text)::date = d.day AND COALESCE(o.order_status, '') <> 'cancelled'
         GROUP BY d.day ORDER BY d.day`,
        [TZ],
      ),
      listOrders(sql, { page: 1, pageSize: 6 }),
      listLegacyListings(sql, { filter: "all", page: 1, pageSize: 1, branchIds: stockSettings.branchIds }),
      sql.query<{ status: string | null; n: number }>(`SELECT status, count(DISTINCT marketplace_item_id)::int AS n FROM legacy_listings GROUP BY status`),
      sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM products`),
      sql.query<{ ok: number; bad: number; queued: number }>(
        `SELECT count(*) FILTER (WHERE status = 'SUCCEEDED' AND (completed_at AT TIME ZONE $1::text)::date = (now() AT TIME ZONE $1::text)::date)::int AS ok,
                count(*) FILTER (WHERE status IN ('FAILED', 'DIVERGED') AND (completed_at AT TIME ZONE $1::text)::date = (now() AT TIME ZONE $1::text)::date)::int AS bad,
                count(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING'))::int AS queued
         FROM stock_sync_jobs WHERE status IN ('QUEUED', 'RUNNING') OR completed_at > now() - interval '2 days'`,
        [TZ],
      ),
      sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM price_sync_proposals
         WHERE applied_at IS NOT NULL AND status = 'APPLIED' AND (applied_at AT TIME ZONE $1::text)::date = (now() AT TIME ZONE $1::text)::date`,
        [TZ],
      ),
      listJobs(sql, { limit: 6 }),
      listPriceApplications(sql, 6),
      getPriceSettings(sql),
      sql.query<{ key: string; value: Record<string, unknown> }>(`SELECT key, value FROM app_settings WHERE key IN ('meli_scheduler_last_tick', 'meli_last_alert')`),
      sql.query<{ pending: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING', 'RETRYING'))::int AS pending,
                count(*) FILTER (WHERE status = 'FAILED' AND received_at > now() - interval '24 hours')::int AS failed
         FROM marketplace_webhook_events WHERE status IN ('PENDING', 'PROCESSING', 'RETRYING', 'FAILED')`,
      ),
      getConnectionSummary(),
    ]);

  const days: SalesDay[] = salesRows.map((r) => ({ day: r.day, orders: r.orders, amount: num(r.amount) }));
  const sum = (list: SalesDay[]) => list.reduce((a, d) => ({ orders: a.orders + d.orders, amount: a.amount + d.amount }), { orders: 0, amount: 0 });
  const statusCount = (s: string) => listingStatus.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0);
  const setting = (k: string) => settingsRows.find((r) => r.key === k)?.value;
  const tick = setting("meli_scheduler_last_tick") as { at?: string } | undefined;
  const alert = setting("meli_last_alert") as { message?: string; at?: string } | undefined;
  const stockAuto = autoSyncState(stockSettings);
  const priceAuto = autoPriceState(priceSettings);

  return {
    generatedAt: new Date().toISOString(),
    sales: {
      days,
      today: days[days.length - 1] ?? { day: "", orders: 0, amount: 0 },
      last7: sum(days.slice(-7)),
      prev7: sum(days.slice(0, 7)),
    },
    orders: { counts: ordersPage.counts, recent: ordersPage.items },
    listings: {
      counts: legacy.counts ?? (Object.fromEntries(LEGACY_FILTERS.map((f) => [f, 0])) as Record<LegacyFilter, number>),
      active: statusCount("active"),
      paused: statusCount("paused"),
      closed: statusCount("closed"),
    },
    products: products[0]?.n ?? 0,
    stock: { appliedToday: stockToday[0]?.ok ?? 0, problemsToday: stockToday[0]?.bad ?? 0, queued: stockToday[0]?.queued ?? 0, recent: stockRecent },
    price: { appliedToday: priceToday[0]?.n ?? 0, recent: priceRecent },
    automation: {
      stock: { active: stockAuto.active, reason: stockAuto.reason, intervalMin: stockSettings.autoSyncIntervalMin },
      price: { active: priceAuto.active, reason: priceAuto.reason, intervalMin: priceSettings.autoSyncIntervalMin },
      adsHours: { ...adsHoursState(stockSettings), label: adsHoursLabel(stockSettings) },
    },
    connection,
    lastTickAt: tick?.at ?? null,
    lastAlert: alert?.message && alert.at ? { message: alert.message, at: alert.at } : null,
    events: { pending: events[0]?.pending ?? 0, failed: events[0]?.failed ?? 0 },
  };
}
