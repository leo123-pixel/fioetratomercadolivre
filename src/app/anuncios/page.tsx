import { requireAdminPage } from "@/lib/auth/page-guard";
import { DRAFT_TABS, listDrafts, TAB_LISTING } from "@/lib/catalog/drafts";
import { formatDateTime } from "@/lib/format";
import { logger } from "@/lib/logger";
import { getMonitoringSummary } from "@/lib/marketplace/health";
import { kickIfStale } from "@/lib/marketplace/scheduler";
import { getCapabilities } from "@/lib/meli/capabilities";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../PageProblem";
import { ListingsPanel } from "./ListingsPanel";

export const dynamic = "force-dynamic";

const TAB_LABELS: Record<string, string> = {
  rascunhos: "Rascunhos",
  incompletos: "Incompletos",
  prontos: "Prontos",
  publicando: "Em publicação",
  publicados: "Publicados",
  ativos: "Ativos",
  pausados: "Pausados",
  encerrados: "Encerrados",
  excluidos: "Excluídos ou indisponíveis",
  divergencia: "Com divergência",
  "erro-sync": "Erro de sincronização",
  erros: "Com erro",
  desconhecidos: "Resultado desconhecido",
  arquivados: "Arquivados",
};

export default async function AnunciosPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/anuncios")) === "config") return <PageProblem kind="config" />;
  const tab = sp.tab && sp.tab in DRAFT_TABS ? sp.tab : "rascunhos";
  const page = Math.max(1, Number(sp.page) || 1);
  let data, caps, health;
  try {
    const sql = getSql();
    [data, caps, health] = await Promise.all([
      listDrafts(sql, { statuses: DRAFT_TABS[tab], listing: TAB_LISTING[tab], q: sp.q, page, pageSize: 50 }),
      getCapabilities(sql),
      getMonitoringSummary(sql),
    ]);
    await kickIfStale(sql);
  } catch (err) {
    logger.error("Falha ao carregar anúncios", { err });
    return <PageProblem kind="database" />;
  }
  const tabCounts: Record<string, number> = Object.fromEntries(Object.entries(DRAFT_TABS).map(([k, statuses]) => [k, statuses.reduce((acc, s) => acc + (data.counts[s] ?? 0), 0)]));
  for (const [k, filter] of Object.entries(TAB_LISTING)) tabCounts[k] = data.listingCounts[filter] ?? 0;
  const ev = health.events;
  const pending = (ev.byStatus.PENDING ?? 0) + (ev.byStatus.RETRYING ?? 0) + (ev.byStatus.PROCESSING ?? 0);
  const divergences = Object.entries(health.divergences).reduce((a, [, n]) => a + n, 0);
  const lastSync = health.jobs.find((j) => j.type === "LISTINGS_RECONCILE");

  return (
    <>
      <p className="breadcrumb">Mercado Livre</p>
      <div className="page-head">
        <h1>Anúncios</h1>
        <span className="muted">
          Conta: {caps.connected ? `${caps.nickname ?? "—"} (${caps.meliUserId})` : "não conectada"} · modelo:{" "}
          {caps.publicationModel === "USER_PRODUCTS" ? "User Products" : caps.publicationModel === "CLASSIC" ? "clássico" : "não detectado"}
        </span>
      </div>
      <section className="kpis" aria-label="Indicadores de sincronização">
        <a className="kpi" href="/configuracoes/integracoes/mercadolivre/monitoramento">
          <strong>{lastSync ? formatDateTime(lastSync.finishedAt ?? lastSync.startedAt) : "nunca"}</strong>
          <span>Última sincronização{lastSync && lastSync.status !== "COMPLETED" ? ` (${lastSync.status})` : ""}</span>
        </a>
        <a className="kpi" href="/anuncios?tab=publicados">
          <strong>{health.listings.current}</strong>
          <span>Anúncios monitorados (vigentes)</span>
        </a>
        <a className="kpi" href="/configuracoes/integracoes/mercadolivre/monitoramento">
          <strong>{Object.values(ev.last24h).reduce((a, n) => a + n, 0)}</strong>
          <span>Eventos recebidos (24 h)</span>
        </a>
        <a className="kpi" href="/configuracoes/integracoes/mercadolivre/monitoramento?status=PENDING">
          <strong>{pending}</strong>
          <span>Eventos pendentes</span>
        </a>
        <a className="kpi" href="/configuracoes/integracoes/mercadolivre/monitoramento?status=FAILED">
          <strong>{ev.byStatus.FAILED ?? 0}</strong>
          <span>Eventos com erro</span>
        </a>
        <a className="kpi" href="/anuncios?tab=divergencia">
          <strong>{divergences}</strong>
          <span>Divergências abertas</span>
        </a>
      </section>
      <nav className="toolbar" aria-label="Situação dos anúncios" style={{ marginBottom: 12 }}>
        {Object.keys(DRAFT_TABS).map((k) => (
          <a key={k} href={`/anuncios?tab=${k}`} className={`btn btn-sm ${k === tab ? "btn-primary" : "btn-secondary"}`}>
            {TAB_LABELS[k] ?? k} ({tabCounts[k]})
          </a>
        ))}
      </nav>
      <form method="get" action="/anuncios" className="toolbar" style={{ marginBottom: 12 }} role="search">
        <input type="hidden" name="tab" value={tab} />
        <input type="search" name="q" defaultValue={sp.q ?? ""} placeholder="Pesquisar por nome, título ou ID ADS" style={{ maxWidth: 360 }} />
        <button className="btn btn-secondary btn-sm" type="submit">
          Pesquisar
        </button>
      </form>
      <ListingsPanel
        tab={tab}
        rows={JSON.parse(JSON.stringify(data.items))}
        total={data.total}
        page={data.page}
        pageSize={data.pageSize}
        account={{ meliUserId: caps.meliUserId, nickname: caps.nickname, canWrite: caps.canWrite, connected: caps.connected }}
      />
    </>
  );
}
