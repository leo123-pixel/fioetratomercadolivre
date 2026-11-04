import { requireAdminPage } from "@/lib/auth/page-guard";
import { DRAFT_TABS, listDrafts } from "@/lib/catalog/drafts";
import { logger } from "@/lib/logger";
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
  erros: "Com erro",
  desconhecidos: "Resultado desconhecido",
  arquivados: "Arquivados",
};

export default async function AnunciosPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/anuncios")) === "config") return <PageProblem kind="config" />;
  const tab = sp.tab && sp.tab in DRAFT_TABS ? sp.tab : "rascunhos";
  const page = Math.max(1, Number(sp.page) || 1);
  let data, caps;
  try {
    const sql = getSql();
    [data, caps] = await Promise.all([listDrafts(sql, { statuses: DRAFT_TABS[tab], q: sp.q, page, pageSize: 50 }), getCapabilities(sql)]);
  } catch (err) {
    logger.error("Falha ao carregar anúncios", { err });
    return <PageProblem kind="database" />;
  }
  const tabCounts = Object.fromEntries(Object.entries(DRAFT_TABS).map(([k, statuses]) => [k, statuses.reduce((acc, s) => acc + (data.counts[s] ?? 0), 0)]));

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
      <nav className="toolbar" aria-label="Situação dos anúncios" style={{ marginBottom: 12 }}>
        {Object.keys(DRAFT_TABS).map((k) => (
          <a key={k} href={`/anuncios?tab=${k}`} className={`btn btn-sm ${k === tab ? "btn-primary" : "btn-secondary"}`}>
            {TAB_LABELS[k]} ({tabCounts[k]})
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
