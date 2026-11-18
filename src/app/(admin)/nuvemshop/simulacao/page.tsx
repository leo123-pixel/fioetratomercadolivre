import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime } from "@/lib/format";
import { inventoryCoreMode } from "@/lib/inventory/mode";
import { getActivePolicies } from "@/lib/inventory/settings";
import { logger } from "@/lib/logger";
import { simulationRows } from "@/lib/nuvemshop/queries";
import { getLatestStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { NuvemshopTabs } from "../NuvemshopTabs";

export const dynamic = "force-dynamic";

const RELIABILITY: Record<string, { text: string; tone: string }> = {
  RELIABLE: { text: "confiável", tone: "ok" },
  DEGRADED: { text: "degradado (só redução)", tone: "warn" },
  UNKNOWN: { text: "desconhecido", tone: "danger" },
  BLOCKED: { text: "bloqueado", tone: "danger" },
};

const show = (v: number | string | null | undefined) => (v === null || v === undefined ? "—" : String(v));

export default async function NuvemshopSimulacaoPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/nuvemshop/simulacao")) === "config") return <PageProblem kind="config" />;
  const page = Math.max(1, Number(sp.page) || 1);
  let data = null;
  let policy = null;
  try {
    const sql = getSql();
    const store = await getLatestStore(sql);
    if (store) data = await simulationRows(sql, store.storeId, { page, q: sp.q });
    policy = (await getActivePolicies(sql).catch(() => null))?.global ?? null;
  } catch (err) {
    logger.error("Falha ao carregar a simulação Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  const mode = inventoryCoreMode();
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › Simulação de estoque
      </p>
      <div className="page-head">
        <h1>Simulação de cotas ML × Nuvemshop</h1>
        <span className="muted">Inventory Core em modo {mode.mode === "shadow" ? "sombra" : "desativado"} · nada aqui é aplicado</span>
      </div>
      <NuvemshopTabs current="simulation" />
      <div className="alert warn">
        Valores marcados como <span className="sim">simulada</span> são cálculos do Inventory Core, <strong>não</strong> quantidades publicadas. A quantidade “observada” é a lida no canal
        (no ML, pelo sincronizador atual; na Nuvemshop, pela última importação). Para recalcular, rode a reconciliação em{" "}
        <a href="/estoque/controle-central?aba=reconciliacoes">Estoque central › Reconciliações</a>; para testar outra divisão (ex.: ADS 10, reserva 2 → ML 4 + Nuvemshop 4), use o{" "}
        <a href="/estoque/controle-central?aba=simulador">Simulador de cotas</a> e a política em Configuração.
      </div>
      {policy && (
        <p className="muted">
          Política vigente (v{policy.version}): {policy.rules.map((r) => `${r.channel === "nuvemshop" ? "Nuvemshop" : "Mercado Livre"} ${r.type === "PERCENT" ? `${r.value}%` : r.type === "FIXED" ? `${r.value} un.` : "cota zero"}`).join(" · ")}
          {policy.safetyReserve !== null ? ` · reserva de segurança ${policy.safetyReserve}` : " · reserva de segurança herdada da sincronização atual"}
        </p>
      )}
      {!data ? (
        <div className="empty-state">Nenhuma loja conectada ainda.</div>
      ) : (
        <section className="card">
          <form className="toolbar" method="get" style={{ marginBottom: 12 }}>
            <input type="search" name="q" defaultValue={sp.q ?? ""} placeholder="Produto ou ID ADS" aria-label="Busca" style={{ maxWidth: 320 }} />
            <button type="submit" className="btn btn-secondary">
              Buscar
            </button>
            <span className="muted">Depósito da Nuvemshop no Inventory Core: {data.warehouse}</span>
          </form>
          {data.rows.length === 0 ? (
            <div className="empty-state">Nenhum produto ADS com variante Nuvemshop vinculada. Vincule em <a href="/nuvemshop/produtos/vinculacao">Vinculação ADS</a>.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Produto ADS</th>
                    <th>
                      Saldo ADS <span className="real-label">real</span>
                    </th>
                    <th>Reserva seg.</th>
                    <th>Compromissos não refletidos</th>
                    <th>Saldo vendável calculado</th>
                    <th>
                      Cota ML <span className="sim">simulada</span>
                    </th>
                    <th>
                      ML observado <span className="real-label">real</span>
                    </th>
                    <th>
                      Cota Nuvemshop <span className="sim">simulada</span>
                    </th>
                    <th>
                      Nuvemshop observado <span className="real-label">real</span>
                    </th>
                    <th>Confiabilidade</th>
                    <th>Alertas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const rel = r.reliability ? RELIABILITY[r.reliability] : null;
                    return (
                      <tr key={r.productId}>
                        <td className="cell-name">
                          #{r.adsProductId} · {r.name}
                          <small>
                            {r.variants} variante(s) vinculada(s){r.computedAt ? ` · calculado ${formatDateTime(r.computedAt)}` : " · ainda não calculado"}
                          </small>
                        </td>
                        <td>{r.adsStatus === "KNOWN" ? r.adsQuantity : r.adsStatus ? "desconhecido" : "—"}</td>
                        <td>{show(r.safetyReserve)}</td>
                        <td>{show(r.pendingCommitments)}</td>
                        <td>
                          <strong>{show(r.safeSellable)}</strong>
                        </td>
                        <td>
                          <span className="sim">{show(r.mlQuota)}</span>
                        </td>
                        <td>{show(r.mlObserved)}</td>
                        <td>
                          <span className="sim">{show(r.nsQuota)}</span>
                        </td>
                        <td>{r.nsObserved !== null ? r.nsObserved : r.nsStockReported !== null ? `${r.nsStockReported} (total da loja)` : "desconhecido"}</td>
                        <td>{rel ? <span className={`chip ${rel.tone}`}>{rel.text}</span> : <span className="chip">rode a reconciliação</span>}</td>
                        <td>{r.openAlerts ? <a href={`/estoque/controle-central?aba=divergencias`}>{r.openAlerts}</a> : 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="pagination">
            <span className="muted">
              {data.total} produto(s) · página {page} de {pages}
            </span>
            <span className="pages">
              {page > 1 && (
                <a className="btn btn-secondary btn-sm" href={`?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(page - 1) })}`}>
                  Anterior
                </a>
              )}
              {page < pages && (
                <a className="btn btn-secondary btn-sm" href={`?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(page + 1) })}`}>
                  Próxima
                </a>
              )}
            </span>
          </div>
        </section>
      )}
    </>
  );
}
