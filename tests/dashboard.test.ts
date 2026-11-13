import { describe, expect, it } from "vitest";
import { getDashboard } from "@/lib/dashboard";
import { useTestDatabase } from "./helpers/pg";

const t = useTestDatabase();

describe("painel", () => {
  it("resume vendas dos últimos 14 dias (sem cancelados) no horário de Campo Grande", async () => {
    const sql = t.sql();
    const empty = await getDashboard(sql);
    expect(empty.sales.days).toHaveLength(14);
    expect(empty.sales.today).toMatchObject({ orders: 0, amount: 0 });
    expect(empty.connection.status).toBe("disconnected");

    await sql.execute(
      `INSERT INTO marketplace_order_inbox (marketplace_order_id, seller_id, order_status, total_amount, date_created) VALUES
         ('1', 's', 'paid', 100.50, now()),
         ('2', 's', 'paid', 49.50, now()),
         ('3', 's', 'cancelled', 999, now()),
         ('4', 's', 'paid', 30, now() - interval '3 days'),
         ('5', 's', 'paid', 70, now() - interval '20 days')`,
    );
    const d = await getDashboard(sql);
    expect(d.sales.today).toMatchObject({ orders: 2, amount: 150 });
    expect(d.sales.last7).toEqual({ orders: 3, amount: 180 });
    expect(d.sales.days.reduce((a, x) => a + x.orders, 0)).toBe(3);
    expect(d.orders.recent.length).toBeGreaterThan(0);
  });
});
