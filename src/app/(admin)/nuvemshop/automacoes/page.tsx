import { requireAdminPage } from "@/lib/auth/page-guard";
import { logger } from "@/lib/logger";
import { automationOverview } from "@/lib/nuvemshop/automation-queries";
import { AUTOMATIC_CONFIRMATION } from "@/lib/nuvemshop/automation";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { NuvemshopTabs } from "../NuvemshopTabs";
import { AutomationPanel } from "./AutomationPanel";

export const dynamic = "force-dynamic";

export default async function NuvemshopAutomacoesPage() {
  if ((await requireAdminPage("/nuvemshop/automacoes")) === "config") return <PageProblem kind="config" />;
  let data;
  try {
    data = await automationOverview(getSql());
  } catch (err) {
    logger.error("Falha ao carregar as automações Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › Automações
      </p>
      <div className="page-head">
        <h1>Automações Nuvemshop</h1>
        <span className="muted">Preço ADS → Nuvemshop · Estoque pelo Inventory Core → Nuvemshop</span>
      </div>
      <NuvemshopTabs current="automation" />
      <AutomationPanel data={JSON.parse(JSON.stringify(data))} automaticPhrase={AUTOMATIC_CONFIRMATION} />
    </>
  );
}
