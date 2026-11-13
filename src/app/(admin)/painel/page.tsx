import { requireAdminPage } from "@/lib/auth/page-guard";
import { getDashboard, type DashboardData } from "@/lib/dashboard";
import { logger } from "@/lib/logger";
import { kickIfStale } from "@/lib/marketplace/scheduler";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../PageProblem";
import { DashboardView } from "./DashboardView";

export const dynamic = "force-dynamic";

export default async function PainelPage() {
  if ((await requireAdminPage("/painel")) === "config") return <PageProblem kind="config" />;
  let d: DashboardData;
  try {
    const sql = getSql();
    d = await getDashboard(sql);
    await kickIfStale(sql);
  } catch (err) {
    logger.error("Falha ao carregar o painel", { err });
    return <PageProblem kind="database" />;
  }
  return <DashboardView d={d} />;
}

