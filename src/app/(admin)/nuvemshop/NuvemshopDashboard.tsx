"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime, formatNumber } from "@/lib/format";

interface Store {
  storeId: string;
  storeName: string | null;
  storeUrl: string | null;
  originalDomain: string | null;
  planName: string | null;
  mainCurrency: string | null;
  country: string | null;
  multiLocation: boolean | null;
  locationCount: number | null;
  capabilities: Record<string, unknown>;
  connectionStatus: "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
  grantedScopes: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string | null;
  missingScopes: string[];
}

interface Job {
  id: string;
  mode: "FULL" | "INCREMENTAL";
  status: string;
  cursor: { phase?: string; page?: number };
  totalProducts: number | null;
  productsSeen: number;
  variantsSeen: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  removedCount: number;
  failedCount: number;
  attempts: number;
  lastError: string | null;
  requestedBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface Location {
  locationId: string;
  name: string | null;
  isDefault: boolean | null;
  removed: boolean;
  mappingStatus: "UNMAPPED" | "MAPPED" | "EXCLUDED";
  warehouseCode: string | null;
}

interface Summary {
  store: Store | null;
  connected: boolean;
  catalog: { products: number; variants: number; removed: number; linked: number; review: number; noSku: number; images: number };
  counts: Record<string, number> | null;
  lastImport: Job | null;
  recentFailures: number;
  inventory: { mode: { mode: string; reason: string | null }; warehouse: string; pools: number; observed: number; lastRun: string | null };
  locations: Location[];
}

interface View {
  configured: boolean;
  readOnly: { readOnly: true; configured: string | null; warning: string | null };
  store: Store | null;
}

const STATUS_BADGE: Record<Store["connectionStatus"], { cls: string; text: string }> = {
  ACTIVE: { cls: "connected", text: "Conectada" },
  REAUTH_REQUIRED: { cls: "reauth_required", text: "Reautorização necessária" },
  DISCONNECTED: { cls: "disconnected", text: "Desconectada" },
};

const JOB_STATUS: Record<string, { text: string; tone: string }> = {
  PENDING: { text: "na fila", tone: "info" },
  RUNNING: { text: "importando", tone: "info" },
  COMPLETED: { text: "concluída", tone: "ok" },
  PARTIALLY_COMPLETED: { text: "concluída com falhas", tone: "warn" },
  FAILED: { text: "falhou", tone: "danger" },
  CANCELED: { text: "cancelada", tone: "" },
};

const PHASE: Record<string, string> = {
  store: "loja",
  locations: "localizações",
  categories: "categorias",
  products: "produtos",
  finalize: "conferindo removidos",
  match: "sugestões de vínculo",
  done: "concluída",
};

function Kpi({ value, label, href }: { value: number | string; label: string; href?: string }) {
  const body = (
    <>
      <strong>{typeof value === "number" ? formatNumber(value, 0) : value}</strong>
      <span>{label}</span>
    </>
  );
  return href ? (
    <a className="kpi" href={href}>
      {body}
    </a>
  ) : (
    <div className="kpi">{body}</div>
  );
}

export function NuvemshopDashboard({ summary, view, jobs: initialJobs, callbackPath }: { summary: Summary; view: View; jobs: Job[]; callbackPath: string }) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const store = summary.store;
  const active = jobs.find((j) => j.status === "PENDING" || j.status === "RUNNING");

  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const r = await api<{ items: Job[] }>("/api/nuvemshop/import");
      if (r.ok) {
        setJobs(r.data.items);
        if (!r.data.items.some((j) => j.status === "PENDING" || j.status === "RUNNING")) router.refresh();
      }
    }, 4000);
    return () => clearInterval(t);
  }, [active, router]);

  async function run(key: string, fn: () => Promise<{ ok: boolean; text: string }>) {
    setBusy(key);
    setMsg(null);
    const r = await fn();
    setBusy(null);
    setMsg({ kind: r.ok ? "success" : "error", text: r.text });
    if (r.ok) router.refresh();
  }

  const check = () =>
    run("check", async () => {
      const r = await api<{ ok: boolean; storeName: string | null; locations: number | null; error: { message: string } | null }>("/api/nuvemshop/connection", { method: "POST" });
      if (!r.ok) return { ok: false, text: errorText(r) };
      return r.data.ok
        ? { ok: true, text: `Conexão verificada com a API: loja ${r.data.storeName ?? ""} respondeu; ${r.data.locations ?? "?"} localização(ões).` }
        : { ok: false, text: `A consulta à API falhou: ${r.data.error?.message ?? "erro"}` };
    });

  const startImport = (mode: "FULL" | "INCREMENTAL") =>
    run(`import-${mode}`, async () => {
      const r = await api<{ job: Job }>("/api/nuvemshop/import", { method: "POST", body: { mode } });
      if (r.ok) setJobs((j) => [r.data.job, ...j]);
      return r.ok ? { ok: true, text: `Importação ${r.data.job.mode === "FULL" ? "completa" : "incremental"} enfileirada.` } : { ok: false, text: errorText(r) };
    });

  const cancel = (id: string) =>
    run("cancel", async () => {
      const r = await api(`/api/nuvemshop/import/${id}/cancel`, { method: "POST" });
      return r.ok ? { ok: true, text: "Importação cancelada (o que já foi gravado permanece)." } : { ok: false, text: errorText(r) };
    });

  const disconnect = () =>
    run("disconnect", async () => {
      const r = await api("/api/nuvemshop/disconnect", { method: "POST" });
      setConfirmDisconnect(false);
      return r.ok ? { ok: true, text: "Loja desconectada: o token local foi apagado. Catálogo e vínculos ficam como histórico." } : { ok: false, text: errorText(r) };
    });

  const saveLocation = (l: Location, status: Location["mappingStatus"], warehouseCode: string | null) =>
    run(`loc-${l.locationId}`, async () => {
      const r = await api("/api/nuvemshop/locations", { method: "PUT", body: { locationId: l.locationId, status, warehouseCode } });
      return r.ok ? { ok: true, text: `Localização ${l.name ?? l.locationId} salva.` } : { ok: false, text: errorText(r) };
    });

  const badge = store ? STATUS_BADGE[store.connectionStatus] : STATUS_BADGE.DISCONNECTED;
  const c = summary.counts ?? {};

  return (
    <>
      {msg && (
        <div className={`alert ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      {!view.configured && (
        <div className="alert warn">
          Integração não configurada no servidor: defina NUVEMSHOP_APP_ID, NUVEMSHOP_CLIENT_SECRET e NUVEMSHOP_REDIRECT_URI (= endereço do integrador +{" "}
          <code>{callbackPath}</code>) na Vercel e faça novo deploy.
        </div>
      )}
      {view.readOnly.warning && <div className="alert warn">{view.readOnly.warning}</div>}

      <section className="card">
        <div className="status-row">
          <h2 style={{ margin: 0 }}>Conexão da loja</h2>
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        </div>
        {store ? (
          <dl className="details">
            <div>
              <dt>Loja</dt>
              <dd>{store.storeName ?? "—"}</dd>
            </div>
            <div>
              <dt>Store ID</dt>
              <dd>{store.storeId}</dd>
            </div>
            <div>
              <dt>Endereço</dt>
              <dd>{store.storeUrl ? <a href={store.storeUrl} target="_blank" rel="noreferrer noopener">{store.storeUrl}</a> : (store.originalDomain ?? "—")}</dd>
            </div>
            <div>
              <dt>Plano</dt>
              <dd>{store.planName ?? "—"}</dd>
            </div>
            <div>
              <dt>Localizações de estoque</dt>
              <dd>
                {store.locationCount ?? "não verificado"}
                {store.multiLocation === true ? " (múltiplos locais)" : store.multiLocation === false ? " (local único)" : ""}
                {store.capabilities?.locationsReadable === false ? " — sem permissão de leitura" : ""}
              </dd>
            </div>
            <div>
              <dt>Permissões concedidas</dt>
              <dd>{store.grantedScopes ?? "—"}</dd>
            </div>
            <div>
              <dt>Conectada em</dt>
              <dd>{formatDateTime(store.connectedAt)}</dd>
            </div>
            <div>
              <dt>Última consulta bem-sucedida</dt>
              <dd>{formatDateTime(store.lastSuccessfulCheckAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">Nenhuma loja conectada.</p>
        )}
        {store?.missingScopes?.length ? <div className="alert warn" style={{ marginTop: 12 }}>Permissões faltando: {store.missingScopes.join(", ")}</div> : null}
        {store?.lastError && store.connectionStatus !== "DISCONNECTED" ? <div className="alert error" style={{ marginTop: 12 }}>{store.lastError}</div> : null}
        <div className="toolbar" style={{ marginTop: 16 }}>
          {(!store || store.connectionStatus !== "ACTIVE") && (
            <a className={`btn btn-primary${view.configured ? "" : " disabled"}`} href={view.configured ? "/api/auth/nuvemshop" : undefined} aria-disabled={!view.configured}>
              {store?.connectionStatus === "REAUTH_REQUIRED" ? "Reconectar loja" : "Conectar loja"}
            </a>
          )}
          {store && store.connectionStatus !== "DISCONNECTED" && (
            <>
              <button type="button" className="btn btn-secondary" disabled={busy !== null || store.connectionStatus !== "ACTIVE"} onClick={check}>
                {busy === "check" ? "Verificando…" : "Verificar conexão"}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}>
                Desconectar
              </button>
            </>
          )}
        </div>
        {confirmDisconnect && (
          <div className="confirm-box">
            <p>Desconectar apaga o token guardado no integrador. O catálogo importado e os vínculos ficam como histórico. Para revogar o acesso na Nuvemshop, desinstale o aplicativo no painel da loja.</p>
            <div className="toolbar">
              <button type="button" className="btn btn-danger-solid" disabled={busy !== null} onClick={disconnect}>
                Confirmar desconexão
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDisconnect(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="kpis">
        <Kpi value={summary.catalog.products} label="produtos importados" href="/nuvemshop/produtos" />
        <Kpi value={summary.catalog.variants} label="variantes" href="/nuvemshop/produtos" />
        <Kpi value={summary.catalog.linked} label="vinculadas à ADS" href="/nuvemshop/produtos/vinculacao?filter=linked" />
        <Kpi value={c.unlinked ?? 0} label="sem vínculo" href="/nuvemshop/produtos/vinculacao?filter=unlinked" />
        <Kpi value={c.ambiguous ?? 0} label="correspondências ambíguas" href="/nuvemshop/produtos/vinculacao?filter=ambiguous" />
        <Kpi value={c.no_sku ?? 0} label="sem SKU" href="/nuvemshop/produtos/vinculacao?filter=no_sku" />
        <Kpi value={c.review ?? 0} label="vínculos a revisar" href="/nuvemshop/produtos/vinculacao?filter=review" />
        <Kpi value={c.stock_divergent ?? 0} label="estoque divergente da ADS" href="/nuvemshop/produtos/vinculacao?filter=stock_divergent" />
      </div>

      <section className="card">
        <div className="status-row">
          <h2 style={{ margin: 0 }}>Catálogo</h2>
          <span className="muted">
            Última importação: {summary.lastImport ? `${formatDateTime(summary.lastImport.finishedAt ?? summary.lastImport.createdAt)} (${JOB_STATUS[summary.lastImport.status]?.text ?? summary.lastImport.status})` : "nunca"}
            {summary.recentFailures ? ` · ${summary.recentFailures} com falha nos últimos 30 dias` : ""}
          </span>
        </div>
        <p className="hint">
          Lê produtos, variantes, imagens, preços, categorias, localizações e estoque (GET, com paginação e respeito ao limite da API). Atualizar = só o que mudou desde a última importação
          concluída. Nada é alterado na loja.
        </p>
        <div className="toolbar" style={{ margin: "8px 0 12px" }}>
          <button type="button" className="btn btn-primary" disabled={!summary.connected || Boolean(active) || busy !== null} onClick={() => startImport("FULL")}>
            Importar catálogo
          </button>
          <button type="button" className="btn btn-secondary" disabled={!summary.connected || Boolean(active) || busy !== null} onClick={() => startImport("INCREMENTAL")}>
            Atualizar catálogo
          </button>
          <a className="btn btn-secondary" href="/nuvemshop/produtos">
            Consultar produtos
          </a>
          <a className="btn btn-secondary" href="/nuvemshop/produtos/vinculacao">
            Abrir vinculação
          </a>
          <a className="btn btn-secondary" href="/nuvemshop/simulacao">
            Ver simulação de estoque
          </a>
        </div>
        {jobs.length === 0 && <p className="muted">Nenhuma importação ainda.</p>}
        {jobs.slice(0, 6).map((j) => {
          const st = JOB_STATUS[j.status] ?? { text: j.status, tone: "" };
          const pct = j.totalProducts ? Math.min(100, Math.round((j.productsSeen / j.totalProducts) * 100)) : null;
          return (
            <div key={j.id} className="job-line">
              <div className="row">
                <span>
                  <strong>{j.mode === "FULL" ? "Completa" : "Incremental"}</strong> · {formatDateTime(j.createdAt)} · {j.requestedBy}
                </span>
                <span className={`chip ${st.tone}`}>{st.text}</span>
              </div>
              {(j.status === "RUNNING" || j.status === "PENDING") && (
                <>
                  <div className="progress" aria-label="Progresso">
                    <span style={{ width: `${pct ?? 5}%` }} />
                  </div>
                  <small className="muted">
                    Etapa: {PHASE[j.cursor.phase ?? "store"] ?? j.cursor.phase}
                    {j.cursor.phase === "products" && j.cursor.page ? `, página ${j.cursor.page}` : ""}
                    {j.attempts ? ` · tentativa ${j.attempts + 1}` : ""}{" "}
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => cancel(j.id)}>
                      Cancelar
                    </button>
                  </small>
                </>
              )}
              <small className="muted">
                {formatNumber(j.productsSeen, 0)} produtos{j.totalProducts ? ` de ${formatNumber(j.totalProducts, 0)}` : ""} · {formatNumber(j.variantsSeen, 0)} variantes · {j.createdCount} novos ·{" "}
                {j.updatedCount} alterados · {j.unchangedCount} sem mudança · {j.removedCount} removidos{j.failedCount ? ` · ${j.failedCount} com erro` : ""}
              </small>
              {j.lastError && <small className="hint warn">{j.lastError}</small>}
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Localizações de estoque ↔ depósito do Inventory Core</h2>
        <p className="hint">
          A associação nunca é presumida. Só localizações mapeadas entram na leitura do estoque; estoque em localização não mapeada fica como desconhecido (não vira zero). O depósito da
          Nuvemshop no Inventory Core é <strong>{summary.inventory.warehouse}</strong> (Estoque central › Configuração).
        </p>
        {summary.locations.length === 0 ? (
          <p className="muted">Nenhuma localização lida ainda (verifique a conexão ou importe o catálogo).</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Localização</th>
                  <th>ID</th>
                  <th>Situação</th>
                  <th>Depósito</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {summary.locations.map((l) => (
                  <LocationRow key={l.locationId} l={l} warehouse={summary.inventory.warehouse} busy={busy !== null} onSave={saveLocation} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Leitura pelo Inventory Core</h2>
        <dl className="details">
          <div>
            <dt>Modo do Inventory Core</dt>
            <dd>{summary.inventory.mode.mode === "shadow" ? "sombra (somente leitura e simulação)" : `desativado${summary.inventory.mode.reason ? ` — ${summary.inventory.mode.reason}` : ""}`}</dd>
          </div>
          <div>
            <dt>Produtos ADS com variante vinculada no depósito</dt>
            <dd>{summary.inventory.pools}</dd>
          </div>
          <div>
            <dt>Pools com quantidade Nuvemshop lida</dt>
            <dd>{summary.inventory.observed}</dd>
          </div>
          <div>
            <dt>Última reconciliação sombra</dt>
            <dd>{formatDateTime(summary.inventory.lastRun)}</dd>
          </div>
        </dl>
        <p className="hint">
          A reconciliação do <a href="/estoque/controle-central?aba=reconciliacoes">Estoque central</a> lê as variantes vinculadas e calcula a cota Nuvemshop <span className="sim">simulada</span>.
          Nenhuma cota é aplicada nesta fase.
        </p>
      </section>
    </>
  );
}

function LocationRow({ l, warehouse, busy, onSave }: { l: Location; warehouse: string; busy: boolean; onSave: (l: Location, s: Location["mappingStatus"], w: string | null) => void }) {
  const [status, setStatus] = useState<Location["mappingStatus"]>(l.mappingStatus);
  const [code, setCode] = useState(l.warehouseCode ?? warehouse);
  return (
    <tr>
      <td>
        {l.name ?? "—"} {l.isDefault ? <span className="chip info">padrão</span> : null} {l.removed ? <span className="chip warn">não existe mais na loja</span> : null}
      </td>
      <td>
        <small className="muted">{l.locationId}</small>
      </td>
      <td>
        <select value={status} onChange={(e) => setStatus(e.target.value as Location["mappingStatus"])} aria-label={`Situação da localização ${l.name ?? l.locationId}`}>
          <option value="UNMAPPED">não mapeada</option>
          <option value="MAPPED">mapeada</option>
          <option value="EXCLUDED">excluída do cálculo</option>
        </select>
      </td>
      <td>
        <input type="text" value={code} disabled={status !== "MAPPED"} onChange={(e) => setCode(e.target.value.toLowerCase())} aria-label="Depósito" style={{ maxWidth: 140 }} />
      </td>
      <td>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onSave(l, status, status === "MAPPED" ? code : null)}>
          Salvar
        </button>
      </td>
    </tr>
  );
}
