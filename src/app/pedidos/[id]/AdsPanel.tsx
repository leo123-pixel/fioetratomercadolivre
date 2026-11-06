"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime, formatMoney } from "@/lib/format";

interface Issue {
  code: string;
  message: string;
  blocking: boolean;
}

interface State {
  environment: { host: string; environment: string; writeAllowed: boolean };
  externalId: string;
  validation: { ok: boolean; issues: Issue[]; totals: { itemsAds: number; itemsMl: number; mlTotal: number | null; mlPaid: number | null; adsTotal: number | null } };
  payload: unknown;
  payloadHash: string | null;
  billing: {
    status: string;
    missing: string[];
    docType: string | null;
    docNumber: string | null;
    name: string | null;
    stateRegistration: string | null;
    taxpayerType: string | null;
    address: Record<string, string | null>;
    fetchedAt: string;
  } | null;
  customer: { status: string; adsClienteId: number | null; lastError: string | null; checkedAt: string | null } | null;
  customerDraft: {
    missing: string[];
    request: unknown;
    city: { code: string; name: string; source: string; via?: string; billingCity: string | null } | null;
    cityOptions: { code: string; name: string }[] | null;
  } | null;
  submissions: { id: string; externalId: string; environment: string; status: string; adsPedidoId: number | null; adsStatus: string | null; attempts: number; requestedBy: string; lastError: string | null; createdAt: string; completedAt: string | null }[];
  attempts: { id: string; operation: string; httpStatus: number | null; error: string | null; durationMs: number | null; createdAt: string; response: unknown }[];
}

const CUSTOMER_LABEL: Record<string, string> = {
  FOUND: "Encontrado na ADS",
  CREATED: "Cadastrado na ADS pelo integrador",
  NOT_FOUND: "Não existe na ADS",
  AMBIGUOUS: "Duplicado na ADS",
  CREATING: "Cadastro em andamento",
  UNKNOWN: "Resultado do cadastro incerto",
  ERROR: "Erro na consulta",
};
const CITY_SOURCE: Record<string, string> = {
  NOME: "pelo nome da cidade (lista oficial do IBGE)",
  CEP: "pelo CEP",
  ADS: "pelo cadastro de cidades da ADS",
  MANUAL: "escolhido manualmente",
};

/** Escolha manual do município (lista oficial do IBGE da UF do endereço). */
function CityPicker({ options, billingCity, disabled, onSave }: { options: { code: string; name: string }[]; billingCity: string | null; disabled: boolean; onSave: (code: string) => void }) {
  const [q, setQ] = useState("");
  const [code, setCode] = useState("");
  const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const filtered = q ? options.filter((o) => norm(o.name).includes(norm(q))) : options;
  return (
    <div style={{ margin: "8px 0", padding: 10, border: "1px solid var(--warn-fg)", borderRadius: 6 }}>
      <strong>Município não identificado automaticamente</strong>
      <p className="muted" style={{ margin: "4px 0" }}>
        O Mercado Livre informou a cidade &quot;{billingCity ?? "—"}&quot;, que não está na lista oficial do IBGE, e o CEP não foi confirmado. Escolha o município correto (confira o CEP no endereço acima).
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="input" placeholder="Filtrar município" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
        <select className="input" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 280 }}>
          <option value="">Selecione ({filtered.length})</option>
          {filtered.slice(0, 500).map((o) => (
            <option key={o.code} value={o.code}>
              {o.name} — {o.code}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary btn-sm" type="button" disabled={disabled || !code} onClick={() => onSave(code)}>
          Usar este município
        </button>
      </div>
    </div>
  );
}

const SUB_TONE: Record<string, string> = { SENT: "ok", SENDING: "info", UNKNOWN: "warn", FAILED: "danger", CANCELED: "" };

export function AdsPanel({ id }: { id: string }) {
  const router = useRouter();
  const [s, setS] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");

  const load = useCallback(async () => {
    const r = await api<State>(`/api/orders/${id}/ads`);
    if (!r.ok) return setLoadError(errorText(r));
    setLoadError(null);
    setS(r.data);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, body: Record<string, unknown>, ok: (d: Record<string, unknown>) => string) {
    setBusy(key);
    setMsg(null);
    const r = await api<Record<string, unknown>>(`/api/orders/${id}/ads`, { body });
    setBusy(null);
    if (!r.ok) {
      const details = Array.isArray((r.data as { details?: unknown }).details) ? ` — ${((r.data as { details: Issue[] }).details).map((d) => d.message).join("; ")}` : "";
      setMsg({ kind: "error", text: errorText(r) + details });
    } else setMsg({ kind: "success", text: ok(r.data) });
    await load();
    router.refresh();
  }

  async function reveal() {
    if (revealed) return setRevealed(null);
    const r = await api<State>(`/api/orders/${id}/ads?reveal=1`);
    if (r.ok) setRevealed(r.data.billing?.docNumber ?? null);
  }

  if (loadError) return <div className="alert error">Integração ADS: {loadError}</div>;
  if (!s) return <div className="card">Carregando integração ADS…</div>;
  const active = s.submissions.find((x) => ["SENDING", "SENT", "UNKNOWN"].includes(x.status));
  const blocking = s.validation.issues.filter((i) => i.blocking);
  const prod = s.environment.environment === "producao";
  const confirmWord = prod ? "ENVIAR PRODUCAO" : "ENVIAR";
  const canSend = s.environment.writeAllowed && s.validation.ok && !!s.payloadHash && !active && checked && typed === confirmWord;
  const b = s.billing;

  return (
    <section className="card">
      <h2>Integração ADS</h2>
      <div className={`alert ${prod || !s.environment.writeAllowed ? "error" : "warn"}`}>
        Ambiente ADS: <strong>{prod ? "PRODUÇÃO" : "homologação"}</strong> ({s.environment.host}).{" "}
        {!s.environment.writeAllowed
          ? prod
            ? "Envio BLOQUEADO: escrita em produção não habilitada (ADS_PRODUCTION_WRITE_ENABLED)."
            : "Envio BLOQUEADO (ADS_WRITE_DISABLED)."
          : prod
            ? "ATENÇÃO: o pedido gera movimentação REAL no ERP (estoque, financeiro e NF-e)."
            : "Envio manual para testes."}{" "}
        Nada é enviado automaticamente.
      </div>
      {msg && (
        <div className={`alert ${msg.kind}`} role="status">
          {msg.text}
        </div>
      )}

      <h3>1. Comprador</h3>
      {!b ? (
        <p className="muted">Dados fiscais ainda não consultados.</p>
      ) : (
        <dl className="details">
          <div>
            <dt>Dados fiscais</dt>
            <dd>
              <span className={`chip ${b.status === "COMPLETE" ? "ok" : "warn"}`}>{b.status === "COMPLETE" ? "Completos" : b.status === "INCOMPLETE" ? "Incompletos" : "Indisponíveis"}</span>
              {b.missing.length > 0 && <small style={{ display: "block", color: "var(--warn-fg)" }}>Faltando: {b.missing.join(", ")}</small>}
            </dd>
          </div>
          <div>
            <dt>{b.docType ?? "Documento"}</dt>
            <dd>
              {revealed ?? b.docNumber ?? "—"}{" "}
              {b.docNumber && (
                <button className="btn btn-secondary btn-sm" type="button" onClick={reveal}>
                  {revealed ? "Ocultar" : "Mostrar"}
                </button>
              )}
            </dd>
          </div>
          <div>
            <dt>Nome / razão social</dt>
            <dd>{b.name ?? "—"}</dd>
          </div>
          <div>
            <dt>IE / contribuinte</dt>
            <dd>
              {b.stateRegistration ?? "—"} {b.taxpayerType ? `· ${b.taxpayerType}` : ""}
            </dd>
          </div>
          <div>
            <dt>Endereço fiscal</dt>
            <dd>
              {[b.address.street, b.address.number, b.address.complement, b.address.neighborhood].filter(Boolean).join(", ") || "—"}
              <small style={{ display: "block" }}>
                {[b.address.city, b.address.state, b.address.zip].filter(Boolean).join(" · ")}
              </small>
            </dd>
          </div>
          <div>
            <dt>Cliente ADS</dt>
            <dd>
              {s.customer ? (
                <>
                  <span className={`chip ${s.customer.status === "FOUND" || s.customer.status === "CREATED" ? "ok" : "warn"}`}>{CUSTOMER_LABEL[s.customer.status] ?? s.customer.status}</span>
                  {s.customer.adsClienteId && <small style={{ display: "block" }}>clienteId {s.customer.adsClienteId}</small>}
                  {s.customer.lastError && <small style={{ display: "block", color: "var(--warn-fg)" }}>{s.customer.lastError}</small>}
                </>
              ) : (
                "não consultado"
              )}
            </dd>
          </div>
        </dl>
      )}
      <div className="actions">
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => act("billing", { action: "billing" }, (d) => `Dados fiscais consultados no Mercado Livre. Cliente ADS: ${String((d as { customerStatus?: string }).customerStatus ?? "não consultado")}.`)}>
          {busy === "billing" ? "Consultando…" : "Consultar dados fiscais (ML) e cliente (ADS)"}
        </button>
        {b?.docNumber && (
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => act("lookup", { action: "customer_lookup" }, () => "Cliente consultado na ADS.")}>
            Consultar cliente na ADS de novo
          </button>
        )}
      </div>
      {s.customerDraft && (s.customer?.status === "NOT_FOUND" || s.customer?.status === "UNKNOWN") && (
        <div className="card" style={{ marginTop: 10 }}>
          <strong>Cadastro de cliente preparado (aprovação manual)</strong>
          {s.customerDraft.missing.length > 0 ? (
            <p style={{ color: "var(--warn-fg)" }}>Não pode ser cadastrado: faltam {s.customerDraft.missing.join(", ")}. Nenhum dado é inventado.</p>
          ) : (
            <p className="muted">Confira os dados antes de cadastrar na ADS.</p>
          )}
          {s.customerDraft.city && (
            <p className="muted" style={{ margin: "4px 0" }}>
              Município: <strong>{s.customerDraft.city.name}</strong> (IBGE {s.customerDraft.city.code}), {CITY_SOURCE[s.customerDraft.city.source] ?? s.customerDraft.city.source}
              {s.customerDraft.city.via ? ` — ${s.customerDraft.city.via}` : ""}
              {s.customerDraft.city.billingCity && s.customerDraft.city.billingCity.toLowerCase() !== s.customerDraft.city.name.toLowerCase() ? `. O ML informou "${s.customerDraft.city.billingCity}" (distrito/bairro ou outra grafia).` : "."}
            </p>
          )}
          {!s.customerDraft.city && s.customerDraft.cityOptions && (
            <CityPicker
              options={s.customerDraft.cityOptions}
              billingCity={(s.billing?.address.city as string | null) ?? null}
              disabled={busy !== null}
              onSave={(code) => void act("city", { action: "set_city", ibge: code }, () => "Município salvo no pedido.")}
            />
          )}
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{JSON.stringify(s.customerDraft.request, null, 2)}</pre>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy !== null || s.customerDraft.missing.length > 0 || !s.environment.writeAllowed}
            onClick={() => {
              if (window.prompt(`Cadastrar este cliente na ADS de ${prod ? "PRODUÇÃO" : "homologação"}? Digite CADASTRAR para confirmar.`) === "CADASTRAR") {
                void act("create", { action: "customer_create", confirm: "CADASTRAR" }, (d) => `Cliente: ${String((d as { customer?: { status?: string } }).customer?.status)}.`);
              }
            }}
          >
            Cadastrar cliente na ADS ({prod ? "PRODUÇÃO" : "homologação"})
          </button>
        </div>
      )}

      <h3>2. Validação</h3>
      <p>
        Itens (ADS): <strong>{formatMoney(String(s.validation.totals.itemsAds))}</strong> · itens (ML): {formatMoney(String(s.validation.totals.itemsMl))} · total do pedido ML:{" "}
        {formatMoney(s.validation.totals.mlTotal === null ? null : String(s.validation.totals.mlTotal))} · pago pelo comprador:{" "}
        {formatMoney(s.validation.totals.mlPaid === null ? null : String(s.validation.totals.mlPaid))} · <strong>total ADS: {formatMoney(s.validation.totals.adsTotal === null ? null : String(s.validation.totals.adsTotal))}</strong>
      </p>
      {s.validation.issues.length === 0 ? (
        <div className="alert success">Pedido válido para envio.</div>
      ) : (
        <ul>
          {s.validation.issues.map((i) => (
            <li key={i.code + i.message} style={{ color: i.blocking ? "var(--danger-fg)" : "var(--warn-fg)" }}>
              {i.blocking ? "Bloqueia: " : "Aviso: "}
              {i.message}
              {i.code === "unmapped_items" && (
                <>
                  {" "}
                  — <a href="/pedidos/mapeamentos">mapear produtos</a>
                </>
              )}
              {i.code === "settings_missing" && (
                <>
                  {" "}
                  — <a href="/configuracoes/pedidos-ads">configurar</a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>3. Prévia do pedido ADS</h3>
      <p className="muted">
        idExterno <code>{s.externalId}</code> · POST /api/v1/&lt;cnpjDistribuidora&gt;/pedidos · documento mascarado na prévia
      </p>
      <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowPayload(!showPayload)} disabled={!s.payload}>
        {showPayload ? "Ocultar payload" : "Visualizar payload ADS"}
      </button>
      {showPayload && <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", maxHeight: 480, overflow: "auto" }}>{JSON.stringify(s.payload, null, 2)}</pre>}

      <h3>4. Envio para a ADS ({prod ? "PRODUÇÃO" : "homologação"})</h3>
      {active ? (
        <p>
          Envio vigente: <span className={`chip ${SUB_TONE[active.status] ?? ""}`}>{active.status}</span>
          {active.adsPedidoId && (
            <>
              {" "}
              · pedido ADS <strong>{active.adsPedidoId}</strong>
            </>
          )}
          {active.adsStatus && <> · situação na ADS: {active.adsStatus}</>}
        </p>
      ) : (
        <>
          <label style={{ display: "block", margin: "6px 0" }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={!s.validation.ok} /> Conferi comprador, itens, valores e parcelas da
            prévia acima.
          </label>
          <input value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder={`Digite ${confirmWord}`} disabled={!s.validation.ok} style={{ maxWidth: 240, marginRight: 8 }} />
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={!canSend || busy !== null}
            onClick={() =>
              act("send", { action: "send", confirm: confirmWord, payloadHash: s.payloadHash }, (d) => {
                const sub = (d as { submission?: { status?: string; adsPedidoId?: number | null; lastError?: string | null } }).submission;
                return sub?.status === "SENT" ? `Pedido confirmado pela ADS: pedidoId ${sub.adsPedidoId}.` : `Resultado: ${sub?.status}. ${sub?.lastError ?? ""}`;
              })
            }
          >
            {busy === "send" ? "Enviando…" : prod ? "Enviar para PRODUÇÃO" : "Enviar para homologação"}
          </button>
          {blocking.length > 0 && <small className="muted" style={{ display: "block" }}>Resolva os bloqueios da validação para habilitar o envio.</small>}
        </>
      )}
      {active && (
        <div className="actions">
          {(active.status === "UNKNOWN" || active.status === "SENDING") && (
            <button className="btn btn-primary btn-sm" type="button" disabled={busy !== null} onClick={() => act("reconcile", { action: "reconcile" }, (d) => `Conciliação: ${String((d as { submission?: { status?: string } }).submission?.status)}.`)}>
              Conciliar pelo idExterno (não reenvia)
            </button>
          )}
          {active.status === "SENT" && (
            <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => act("status", { action: "status" }, (d) => `Situação na ADS: ${String((d as { submission?: { adsStatus?: string } }).submission?.adsStatus ?? "não informada")}.`)}>
              Consultar resultado na ADS
            </button>
          )}
        </div>
      )}

      {s.submissions.length > 0 && (
        <>
          <h3>Histórico de envios</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Criado</th>
                  <th>idExterno</th>
                  <th>Ambiente</th>
                  <th>Situação</th>
                  <th>Pedido ADS</th>
                  <th>Por</th>
                </tr>
              </thead>
              <tbody>
                {s.submissions.map((x) => (
                  <tr key={x.id}>
                    <td>{formatDateTime(x.createdAt)}</td>
                    <td>{x.externalId}</td>
                    <td>{x.environment}</td>
                    <td>
                      <span className={`chip ${SUB_TONE[x.status] ?? ""}`}>{x.status}</span>
                      {x.lastError && <small style={{ display: "block" }}>{x.lastError}</small>}
                    </td>
                    <td>{x.adsPedidoId ?? "—"}</td>
                    <td>{x.requestedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {s.attempts.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Chamadas à ADS ({s.attempts.length})</summary>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Operação</th>
                  <th>HTTP</th>
                  <th>ms</th>
                  <th>Resposta / erro</th>
                </tr>
              </thead>
              <tbody>
                {s.attempts.map((a) => (
                  <tr key={a.id}>
                    <td>{formatDateTime(a.createdAt)}</td>
                    <td>{a.operation}</td>
                    <td>{a.httpStatus ?? "—"}</td>
                    <td>{a.durationMs ?? "—"}</td>
                    <td>
                      <code style={{ fontSize: "0.75rem" }}>{a.error ?? JSON.stringify(a.response)?.slice(0, 300)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
