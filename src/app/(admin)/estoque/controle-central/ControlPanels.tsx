"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { QUOTA_LABEL, TRANSFER_LABEL } from "./labels";

/** Painéis interativos do controle central. Nenhum deles publica nada: só chamam as rotas /api/inventory. */

type RuleType = "PERCENT" | "FIXED" | "ZERO";
interface Rule {
  channel: string;
  type: RuleType;
  value?: number;
  max?: number | null;
  min?: number | null;
  priority: number;
}
const CHANNELS = [
  ["mercadolivre", "Mercado Livre"],
  ["nuvemshop", "Nuvemshop (simulado)"],
] as const;

const intOrNull = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v))));

function RulesEditor({ rules, onChange }: { rules: Rule[]; onChange: (r: Rule[]) => void }) {
  const set = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Canal</th>
            <th>Regra</th>
            <th className="num">Valor</th>
            <th className="num">Mínimo</th>
            <th className="num">Máximo</th>
            <th className="num">Prioridade (1 = maior)</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={r.channel}>
              <td>{CHANNELS.find((c) => c[0] === r.channel)?.[1] ?? r.channel}</td>
              <td>
                <select aria-label={`Regra de ${r.channel}`} value={r.type} onChange={(e) => set(i, { type: e.target.value as RuleType })}>
                  <option value="PERCENT">Percentual</option>
                  <option value="FIXED">Quantidade fixa</option>
                  <option value="ZERO">Cota zero</option>
                </select>
              </td>
              <td className="num">
                <input aria-label={`Valor de ${r.channel}`} type="number" min={0} step={r.type === "PERCENT" ? 0.01 : 1} disabled={r.type === "ZERO"} value={r.type === "ZERO" ? "" : (r.value ?? "")} onChange={(e) => set(i, { value: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </td>
              <td className="num">
                <input aria-label={`Mínimo de ${r.channel}`} type="number" min={0} value={r.min ?? ""} onChange={(e) => set(i, { min: intOrNull(e.target.value) })} />
              </td>
              <td className="num">
                <input aria-label={`Máximo de ${r.channel}`} type="number" min={0} value={r.max ?? ""} onChange={(e) => set(i, { max: intOrNull(e.target.value) })} />
              </td>
              <td className="num">
                <input aria-label={`Prioridade de ${r.channel}`} type="number" min={0} max={100} value={r.priority} onChange={(e) => set(i, { priority: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cleanRules = (rules: Rule[]) =>
  rules.map((r) => ({ channel: r.channel, type: r.type, priority: r.priority, ...(r.type !== "ZERO" ? { value: r.value ?? 0 } : {}), ...(r.min != null ? { min: r.min } : {}), ...(r.max != null ? { max: r.max } : {}) }));

function withAllChannels(rules: Rule[]): Rule[] {
  const out = [...rules];
  CHANNELS.forEach(([c], i) => {
    if (!out.some((r) => r.channel === c)) out.push({ channel: c, type: "ZERO", priority: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------

export function RunButton() {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  async function run() {
    setBusy(true);
    setMsg(null);
    const r = await api<{ status: string; summary: { pools?: number; remoteWrites?: number; discrepancies?: { opened?: number; resolved?: number } } }>("/api/inventory/runs", { body: { live } });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "error", text: errorText(r) });
    const s = r.data.summary;
    setMsg({ tone: "success", text: `Reconciliação ${r.data.status}: ${s.pools ?? 0} pool(s), ${s.discrepancies?.opened ?? 0} divergência(s) nova(s), ${s.discrepancies?.resolved ?? 0} resolvida(s). Escritas remotas: ${s.remoteWrites ?? 0}.` });
    router.refresh();
  }
  return (
    <div>
      <div className="toolbar">
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400, margin: 0 }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Consultar a ADS ao vivo (somente leitura; limitado e só no horário da ADS)
        </label>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? "Reconciliando…" : "Rodar reconciliação (modo sombra)"}
        </button>
      </div>
      {msg && <div className={`alert ${msg.tone}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface SimResult {
  position: { adsQuantity: number | null; pendingCommitments: number; safetyReserve: number; safeSellable: number | null; reliability: string; reasons: string[] };
  plan: { channel: string; policyQuota: number | null; desired: number | null; confirmed: number | null; status: string; reason: string | null }[];
  allocation: { unallocated: number; warnings: string[] };
  worstCaseExposure: number;
  overExposedBy: number;
}

export function SimulatorPanel({ pools, initialRules }: { pools: { poolId: string; skuCode: string; name: string }[]; initialRules: Rule[] }) {
  const [poolId, setPoolId] = useState("");
  const [ads, setAds] = useState("10");
  const [reserve, setReserve] = useState("2");
  const [pending, setPending] = useState("0");
  const [mlAnnounced, setMlAnnounced] = useState("");
  const [rules, setRules] = useState<Rule[]>(
    withAllChannels(
      initialRules.length
        ? initialRules
        : [
            { channel: "mercadolivre", type: "PERCENT", value: 50, priority: 1 },
            { channel: "nuvemshop", type: "PERCENT", value: 50, priority: 2 },
          ],
    ),
  );
  const [remainder, setRemainder] = useState<"PRIORITY" | "UNALLOCATED">("PRIORITY");
  const [res, setRes] = useState<SimResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function simulate() {
    setErr(null);
    const body: Record<string, unknown> = { rules: cleanRules(rules), remainderMode: remainder };
    if (poolId) body.poolId = poolId;
    if (!poolId || ads.trim() !== "") body.adsQuantity = ads.trim() === "" ? null : Number(ads);
    if (!poolId || reserve.trim() !== "") body.safetyReserve = Math.max(0, Math.floor(Number(reserve) || 0));
    if (!poolId || pending.trim() !== "") body.reservations = Number(pending) > 0 ? [{ quantity: Number(pending), state: "PENDING_ERP" }] : [];
    if (mlAnnounced.trim() !== "") body.confirmed = { mercadolivre: Math.max(0, Math.floor(Number(mlAnnounced))) };
    const r = await api<SimResult>("/api/inventory/simulate", { body });
    if (!r.ok) return setErr(errorText(r));
    setRes(r.data);
  }
  return (
    <div className="card">
      <h2>
        Simulador de cotas <span className="sim sim-label">simulação</span>
      </h2>
      <p className="muted">Cálculo puro: nada é gravado nem publicado. Partindo de um pool real, campos em branco usam os valores atuais dele.</p>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="sim-pool">Partir de um pool real (opcional)</label>
          <select id="sim-pool" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
            <option value="">— valores manuais —</option>
            {pools.map((p) => (
              <option key={p.poolId} value={p.poolId}>
                {p.skuCode} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sim-ads">Estoque vendável ADS</label>
          <input id="sim-ads" type="number" value={ads} onChange={(e) => setAds(e.target.value)} placeholder="vazio = desconhecido" />
        </div>
        <div className="field">
          <label htmlFor="sim-res">Reserva de segurança</label>
          <input id="sim-res" type="number" min={0} value={reserve} onChange={(e) => setReserve(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sim-pend">Vendas ainda não refletidas na ADS</label>
          <input id="sim-pend" type="number" min={0} value={pending} onChange={(e) => setPending(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sim-ml">Anunciado hoje no ML (opcional)</label>
          <input id="sim-ml" type="number" min={0} value={mlAnnounced} onChange={(e) => setMlAnnounced(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sim-rem">Sobra do arredondamento</label>
          <select id="sim-rem" value={remainder} onChange={(e) => setRemainder(e.target.value as "PRIORITY" | "UNALLOCATED")}>
            <option value="PRIORITY">Canal de maior prioridade (uma unidade por vez)</option>
            <option value="UNALLOCATED">Fica sem alocar</option>
          </select>
        </div>
      </div>
      <h3 style={{ fontSize: "0.95rem" }}>Política simulada</h3>
      <RulesEditor rules={rules} onChange={setRules} />
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={simulate}>
          Simular
        </button>
      </div>
      {err && <div className="alert error" style={{ marginTop: 12 }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 16 }}>
          <div className="kpis">
            <div className="kpi">
              <strong>{res.position.adsQuantity ?? "?"}</strong>
              <span>estoque ADS</span>
            </div>
            <div className="kpi">
              <strong>{res.position.pendingCommitments}</strong>
              <span>não refletido</span>
            </div>
            <div className="kpi">
              <strong>{res.position.safetyReserve}</strong>
              <span>reserva</span>
            </div>
            <div className="kpi">
              <strong>{res.position.safeSellable ?? "—"}</strong>
              <span>disponível seguro</span>
            </div>
            <div className="kpi">
              <strong>{res.allocation.unallocated ?? 0}</strong>
              <span>sem alocar</span>
            </div>
            <div className="kpi">
              <strong>{res.worstCaseExposure}</strong>
              <span>exposição no pior caso</span>
            </div>
          </div>
          {res.position.reasons.length > 0 && <div className="alert warn">{res.position.reasons.join(" · ")}</div>}
          {res.overExposedBy > 0 && <div className="alert error">Anunciado hoje acima do disponível seguro em {res.overExposedBy} unidade(s).</div>}
          {res.allocation.warnings?.map((w) => (
            <div key={w} className="alert warn">
              {w}
            </div>
          ))}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th className="num">Cota da política</th>
                  <th className="num">Cota segura agora</th>
                  <th className="num">Anunciado</th>
                  <th>Situação</th>
                  <th>Observação</th>
                </tr>
              </thead>
              <tbody>
                {res.plan.map((p) => (
                  <tr key={p.channel}>
                    <td>{CHANNELS.find((c) => c[0] === p.channel)?.[1] ?? p.channel}</td>
                    <td className="num">
                      <span className="sim">{p.policyQuota ?? "—"}</span>
                    </td>
                    <td className="num">
                      <span className="sim">{p.desired ?? "—"}</span>
                    </td>
                    <td className="num">{p.confirmed ?? "?"}</td>
                    <td>
                      <span className={`chip ${QUOTA_LABEL[p.status]?.tone ?? ""}`}>{QUOTA_LABEL[p.status]?.text ?? p.status}</span>
                    </td>
                    <td>{p.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Location {
  branchId: string;
  warehouseCode: string;
  status: "MAPPED" | "UNMAPPED" | "EXCLUDED";
  source: string;
  version: number;
  updatedBy: string | null;
  updatedAt: string | Date;
}

export function LocationsEditor({ locations }: { locations: Location[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(locations);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  async function save(l: Location) {
    const r = await api("/api/inventory/locations", { method: "PUT", body: { branchId: l.branchId, warehouseCode: l.warehouseCode, status: l.status, expectedVersion: l.version } });
    setMsg(r.ok ? { tone: "success", text: `Filial ${l.branchId} salva.` } : { tone: "error", text: errorText(r) });
    if (r.ok) router.refresh();
  }
  return (
    <div className="card">
      <h2>Filiais ADS → depósitos</h2>
      <p className="muted">Só filiais “mapeadas” entram no cálculo, e só são somadas as do mesmo depósito. Filiais novas aparecem como “não mapeadas”.</p>
      {rows.length === 0 ? (
        <div className="empty-state">Nenhuma filial descoberta ainda (rode uma reconciliação).</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Filial</th>
                <th>Depósito</th>
                <th>Situação</th>
                <th>Origem</th>
                <th>Atualizado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={l.branchId}>
                  <td>{l.branchId}</td>
                  <td>
                    <input aria-label={`Depósito da filial ${l.branchId}`} type="text" value={l.warehouseCode} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, warehouseCode: e.target.value.toLowerCase() } : x)))} />
                  </td>
                  <td>
                    <select aria-label={`Situação da filial ${l.branchId}`} value={l.status} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, status: e.target.value as Location["status"] } : x)))}>
                      <option value="MAPPED">mapeada</option>
                      <option value="UNMAPPED">não mapeada</option>
                      <option value="EXCLUDED">excluída</option>
                    </select>
                  </td>
                  <td>{l.source}</td>
                  <td>
                    {formatDateTime(l.updatedAt)}
                    {l.updatedBy ? ` · ${l.updatedBy}` : ""}
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => save(l)}>
                      Salvar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {msg && <div className={`alert ${msg.tone}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface PolicyVersion {
  id: string;
  version: number;
  safetyReserve: number | null;
  remainderMode: "PRIORITY" | "UNALLOCATED";
  rules: Rule[];
  active?: boolean;
  createdBy: string;
  createdAt: string | Date;
  notes: string | null;
}

export function PolicyEditor({ versions }: { versions: PolicyVersion[] }) {
  const router = useRouter();
  const current = versions.find((v) => v.active) ?? versions[0];
  const [rules, setRules] = useState<Rule[]>(withAllChannels(current?.rules ?? []));
  const [reserve, setReserve] = useState(current?.safetyReserve === null || current?.safetyReserve === undefined ? "" : String(current.safetyReserve));
  const [remainder, setRemainder] = useState<"PRIORITY" | "UNALLOCATED">(current?.remainderMode ?? "PRIORITY");
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  async function save() {
    const r = await api("/api/inventory/policy", {
      method: "PUT",
      body: { safetyReserve: reserve.trim() === "" ? null : Math.max(0, Math.floor(Number(reserve))), remainderMode: remainder, rules: cleanRules(rules), notes: notes || null, expectedVersion: current?.version ?? 0 },
    });
    setMsg(r.ok ? { tone: "success", text: "Nova versão da política salva. Vale a partir da próxima reconciliação (somente cálculo sombra)." } : { tone: "error", text: errorText(r) });
    if (r.ok) router.refresh();
  }
  return (
    <div className="card">
      <h2>Política global de cotas</h2>
      <p className="muted">
        Padrão conservador: Mercado Livre com a disponibilidade segura e Nuvemshop com cota zero. Cada alteração cria uma nova versão (histórico abaixo). Reserva em
        branco = herda a da sincronização atual.
      </p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pol-res">Reserva de segurança (unidades)</label>
          <input id="pol-res" type="number" min={0} value={reserve} onChange={(e) => setReserve(e.target.value)} placeholder="herdar" />
        </div>
        <div className="field">
          <label htmlFor="pol-rem">Sobra do arredondamento</label>
          <select id="pol-rem" value={remainder} onChange={(e) => setRemainder(e.target.value as "PRIORITY" | "UNALLOCATED")}>
            <option value="PRIORITY">Canal de maior prioridade</option>
            <option value="UNALLOCATED">Fica sem alocar</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="pol-notes">Observação</label>
          <input id="pol-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <RulesEditor rules={rules} onChange={setRules} />
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={save}>
          Salvar nova versão
        </button>
        <span className="muted">Versão atual: {current?.version ?? "—"}</span>
      </div>
      {msg && <div className={`alert ${msg.tone}`} style={{ marginTop: 12 }}>{msg.text}</div>}
      <details className="raw" style={{ marginTop: 12 }}>
        <summary>Histórico de versões</summary>
        {versions.map((v) => (
          <div key={v.id} className="hint">
            v{v.version} {v.active ? "(ativa)" : ""} · {formatDateTime(v.createdAt)} · {v.createdBy} · reserva {v.safetyReserve ?? "herdada"} ·{" "}
            {v.rules.map((r) => `${r.channel}: ${r.type}${r.type !== "ZERO" ? ` ${r.value}` : ""}`).join(", ")}
          </div>
        ))}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Settings {
  channelWarehouses: Record<string, string>;
  adsDeductsOnOrderCreated: boolean;
  adsReflectedStatuses: string[];
  pendingReconcileAfterDays: number;
  orderLookbackDays: number;
  maxSnapshotAgeMinutes: number;
  liveAdsMaxProducts: number;
}

export function SettingsEditor({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [statuses, setStatuses] = useState(settings.adsReflectedStatuses.join(", "));
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  async function save() {
    const r = await api("/api/inventory/settings", {
      method: "PATCH",
      body: {
        channelWarehouses: s.channelWarehouses,
        adsDeductsOnOrderCreated: s.adsDeductsOnOrderCreated,
        adsReflectedStatuses: statuses.split(",").map((x) => x.trim()).filter(Boolean),
        pendingReconcileAfterDays: s.pendingReconcileAfterDays,
        orderLookbackDays: s.orderLookbackDays,
        maxSnapshotAgeMinutes: s.maxSnapshotAgeMinutes,
        liveAdsMaxProducts: s.liveAdsMaxProducts,
      },
    });
    setMsg(r.ok ? { tone: "success", text: "Configuração salva." } : { tone: "error", text: errorText(r) });
    if (r.ok) router.refresh();
  }
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Math.max(1, Math.floor(Number(e.target.value) || 1)) });
  return (
    <div className="card">
      <h2>Semântica da baixa na ADS e parâmetros</h2>
      <div className="alert warn">
        Ainda não está confirmado com a Tecdisa em que momento a ADS baixa o saldo. Enquanto não houver confirmação, deixe “a ADS baixa ao criar o pedido”
        desmarcado: o pedido enviado continua descontado até a situação na ADS comprovar a baixa.
      </div>
      <div className="form-grid">
        <div className="field full">
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={s.adsDeductsOnOrderCreated} onChange={(e) => setS({ ...s, adsDeductsOnOrderCreated: e.target.checked })} /> A ADS baixa/reserva o saldo ao
            criar o pedido (confirmado com a Tecdisa)
          </label>
        </div>
        <div className="field full">
          <label htmlFor="set-st">Situações do pedido na ADS que comprovam a baixa (separadas por vírgula)</label>
          <input id="set-st" type="text" value={statuses} onChange={(e) => setStatuses(e.target.value)} placeholder='ex.: Faturado, Nota Emitida' />
        </div>
        <div className="field">
          <label htmlFor="set-ml">Depósito do Mercado Livre</label>
          <input id="set-ml" type="text" value={s.channelWarehouses.mercadolivre ?? ""} onChange={(e) => setS({ ...s, channelWarehouses: { ...s.channelWarehouses, mercadolivre: e.target.value.toLowerCase() } })} />
        </div>
        <div className="field">
          <label htmlFor="set-ns">Depósito da Nuvemshop (simulado)</label>
          <input id="set-ns" type="text" value={s.channelWarehouses.nuvemshop ?? ""} onChange={(e) => setS({ ...s, channelWarehouses: { ...s.channelWarehouses, nuvemshop: e.target.value.toLowerCase() } })} />
        </div>
        <div className="field">
          <label htmlFor="set-stale">Pendente vira “reconciliar” após (dias)</label>
          <input id="set-stale" type="number" min={1} value={s.pendingReconcileAfterDays} onChange={num("pendingReconcileAfterDays")} />
        </div>
        <div className="field">
          <label htmlFor="set-look">Janela de pedidos lidos (dias)</label>
          <input id="set-look" type="number" min={1} value={s.orderLookbackDays} onChange={num("orderLookbackDays")} />
        </div>
        <div className="field">
          <label htmlFor="set-age">Idade máxima do saldo ADS confiável (min)</label>
          <input id="set-age" type="number" min={5} value={s.maxSnapshotAgeMinutes} onChange={num("maxSnapshotAgeMinutes")} />
        </div>
        <div className="field">
          <label htmlFor="set-live">Produtos por consulta ao vivo</label>
          <input id="set-live" type="number" min={1} max={500} value={s.liveAdsMaxProducts} onChange={num("liveAdsMaxProducts")} />
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={save}>
          Salvar configuração
        </button>
      </div>
      {msg && <div className={`alert ${msg.tone}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Outcome = "confirmed" | "failed" | "uncertain";

export function TransferSimulator({ pools }: { pools: { poolId: string; skuCode: string; name: string; mlDesired: number | null; nsDesired: number | null }[] }) {
  const router = useRouter();
  const [poolId, setPoolId] = useState(pools[0]?.poolId ?? "");
  const [from, setFrom] = useState("mercadolivre");
  const [qty, setQty] = useState("1");
  const [dec, setDec] = useState<Outcome>("confirmed");
  const [inc, setInc] = useState<Outcome>("confirmed");
  const [res, setRes] = useState<{ id: string; state: string; error: string | null; steps: { state: string; note: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const to = from === "mercadolivre" ? "nuvemshop" : "mercadolivre";
  const pool = pools.find((p) => p.poolId === poolId);
  async function simulate() {
    setErr(null);
    const r = await api<{ transfer: NonNullable<typeof res> }>("/api/inventory/transfers", {
      body: { poolId, fromChannel: from, toChannel: to, quantity: Math.max(1, Math.floor(Number(qty) || 1)), outcomes: { sourceDecrease: dec, destinationIncrease: inc } },
    });
    if (!r.ok) return setErr(errorText(r));
    setRes(r.data.transfer);
    router.refresh();
  }
  async function cancel() {
    if (!res) return;
    const r = await api(`/api/inventory/transfers/${res.id}/cancel`, { method: "POST" });
    if (!r.ok) return setErr(errorText(r));
    setRes(null);
    router.refresh();
  }
  return (
    <div className="card">
      <h2>
        Transferência de cota entre canais <span className="sim sim-label">simulação</span>
      </h2>
      <p className="muted">
        Protocolo seguro: valida → registra → reduz a origem → confirma por leitura → só então libera ao destino → confirma. Nesta fase os resultados remotos são
        simulados e as cotas reais não mudam.
      </p>
      {pools.length === 0 ? (
        <div className="empty-state">Nenhum pool disponível.</div>
      ) : (
        <div className="inline-form">
          <div className="field">
            <label htmlFor="tr-pool">Pool</label>
            <select id="tr-pool" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
              {pools.map((p) => (
                <option key={p.poolId} value={p.poolId}>
                  {p.skuCode} (ML {p.mlDesired ?? "—"} / NS {p.nsDesired ?? "—"})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tr-from">De</label>
            <select id="tr-from" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="mercadolivre">Mercado Livre → Nuvemshop</option>
              <option value="nuvemshop">Nuvemshop → Mercado Livre</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="tr-qty">Quantidade</label>
            <input id="tr-qty" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="tr-dec">Redução na origem (simulada)</label>
            <select id="tr-dec" value={dec} onChange={(e) => setDec(e.target.value as Outcome)}>
              <option value="confirmed">confirmada</option>
              <option value="failed">falha</option>
              <option value="uncertain">incerta</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="tr-inc">Aumento no destino (simulado)</label>
            <select id="tr-inc" value={inc} onChange={(e) => setInc(e.target.value as Outcome)}>
              <option value="confirmed">confirmado</option>
              <option value="failed">falha</option>
              <option value="uncertain">incerto</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={simulate} disabled={!pool}>
            Simular transferência
          </button>
        </div>
      )}
      {err && <div className="alert error" style={{ marginTop: 12 }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 12 }}>
          <p>
            Resultado: <span className={`chip ${TRANSFER_LABEL[res.state]?.tone ?? ""}`}>{TRANSFER_LABEL[res.state]?.text ?? res.state}</span> {res.error && <span className="muted">— {res.error}</span>}
          </p>
          <ol>
            {res.steps.map((s, i) => (
              <li key={i}>
                <strong>{s.state}</strong>: {s.note}
              </li>
            ))}
          </ol>
          {["BLOCKED", "REQUIRES_RECONCILIATION"].includes(res.state) && (
            <button className="btn btn-secondary btn-sm" onClick={cancel}>
              Cancelar esta transferência simulada
            </button>
          )}
        </div>
      )}
    </div>
  );
}
