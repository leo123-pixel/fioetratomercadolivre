import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime } from "@/lib/format";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { LEGACY_FILTERS, listLegacyListings, type LegacyFilter } from "@/lib/stock/legacy";
import { getPriceProposals, getPriceSettings, latestPriceRun, listPriceApplications } from "@/lib/stock/prices";
import { getRunProposals, latestRun, listJobs } from "@/lib/stock/reconcile";
import { autoSyncState, envAutoSyncAllowed, getStockSettings } from "@/lib/stock/settings";
import { PageProblem } from "../../PageProblem";
import { LinkingPanel } from "./LinkingPanel";
import { PricePanel } from "./PricePanel";
import { SettingsPanel } from "./SettingsPanel";
import { SyncPanel } from "./SyncPanel";

export const dynamic = "force-dynamic";

const FILTER_LABELS: Record<LegacyFilter, string> = {
  all: "Todos",
  unmapped: "Não vinculados",
  pending: "Sugestão pendente",
  ambiguous: "Ambíguos",
  linked: "Vinculados",
  divergent: "Estoque divergente",
  price_divergent: "Preço divergente",
  ads_zero: "Estoque ADS zero",
  ads_unknown: "Sem estoque ADS conhecido",
  multi: "Vários anúncios por produto",
  unmanageable: "Não gerenciável pela API",
  awaiting: "Aguardando sincronização",
};

export default async function VinculacaoPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/anuncios/vinculacao")) === "config") return <PageProblem kind="config" />;
  const filter = (LEGACY_FILTERS as readonly string[]).includes(sp.filter ?? "") ? (sp.filter as LegacyFilter) : "unmapped";
  const page = Math.max(1, Number(sp.page) || 1);
  let data, settings, run, proposals, jobs, discovery, priceSettings, priceRun, priceProposals, priceApplied;
  try {
    const sql = getSql();
    settings = await getStockSettings(sql);
    [data, run, jobs, discovery] = await Promise.all([
      listLegacyListings(sql, { filter, q: sp.q, page, pageSize: 50, branchIds: settings.branchIds }),
      latestRun(sql, "DRY_RUN"),
      listJobs(sql, { limit: 30 }),
      sql.query<{ value: { listed?: number; complete?: boolean }; updatedAt: Date }>(`SELECT value, updated_at AS "updatedAt" FROM app_settings WHERE key = 'legacy_discovery_last'`),
    ]);
    proposals = run ? await getRunProposals(sql, run.id) : [];
    [priceSettings, priceRun, priceApplied] = await Promise.all([getPriceSettings(sql), latestPriceRun(sql), listPriceApplications(sql, 30)]);
    priceProposals = priceRun ? await getPriceProposals(sql, priceRun.id) : [];
  } catch (err) {
    logger.error("Falha ao carregar a vinculação de anúncios", { err });
    return <PageProblem kind="database" />;
  }
  const last = discovery[0];
  const auto = autoSyncState(settings);
  return (
    <>
      <p className="breadcrumb">
        <a href="/anuncios">Anúncios</a> › Vinculação, estoque e preço
      </p>
      <div className="page-head">
        <h1>Vinculação de anúncios, estoque e preço</h1>
        <span className="muted">
          Última leitura da conta: {last ? `${formatDateTime(last.updatedAt)} (${last.value.listed ?? 0} anúncios${last.value.complete === false ? ", parcial" : ""})` : "nunca"} · automação:{" "}
          {auto.active ? "ativa" : "desativada"}
        </span>
      </div>
      <div className="alert info">
        Vincule cada anúncio do Mercado Livre ao produto da ADS. Sugestões vêm de SKU, GTIN ou código do fabricante — nunca do título — e só valem depois da sua
        confirmação. As alterações feitas no Mercado Livre são a <strong>quantidade</strong> e, nos anúncios legados, o <strong>preço</strong> (tabela da ADS), sempre
        depois de simular e confirmar.
      </div>
      <LinkingPanel
        filter={filter}
        filterLabels={FILTER_LABELS}
        q={sp.q ?? ""}
        rows={JSON.parse(JSON.stringify(data.items))}
        counts={data.counts}
        total={data.total}
        page={data.page}
        pageSize={data.pageSize}
      />
      <SyncPanel run={run ? JSON.parse(JSON.stringify(run)) : null} proposals={JSON.parse(JSON.stringify(proposals))} jobs={JSON.parse(JSON.stringify(jobs))} stockSourceConfirmed={settings.stockSourceConfirmed} />
      <PricePanel
        run={priceRun ? JSON.parse(JSON.stringify(priceRun)) : null}
        proposals={JSON.parse(JSON.stringify(priceProposals))}
        applied={JSON.parse(JSON.stringify(priceApplied))}
        settings={priceSettings}
      />
      <SettingsPanel settings={JSON.parse(JSON.stringify(settings))} envAutoSyncAllowed={envAutoSyncAllowed()} autoSync={auto} />
    </>
  );
}
