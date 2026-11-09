"use client";

import { useState } from "react";
import type { ConnectionSummary } from "@/lib/meli/connection";
import { DISCONNECT_CONFIRMATION } from "@/lib/meli/messages";

const STATUS_LABEL: Record<ConnectionSummary["status"], string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  reauth_required: "Reautorização necessária",
};

type Feedback = { kind: "success" | "error" | "warn"; text: string } | null;

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(value));
}

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

export function ConnectionPanel({ initial }: { initial: ConnectionSummary }) {
  const [summary, setSummary] = useState(initial);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<"test" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  async function reload() {
    const res = await fetch("/api/mercadolivre/connection", { cache: "no-store" });
    if (res.ok) setSummary((await res.json()) as ConnectionSummary);
  }

  async function testConnection() {
    setBusy("test");
    setFeedback(null);
    try {
      const { ok, status, data } = await postJson("/api/mercadolivre/connection/test");
      if (status === 401) return window.location.assign("/login?next=/configuracoes/integracoes/mercadolivre");
      setFeedback(
        ok
          ? { kind: "success", text: `Chamada a /users/me OK: conta ${String(data.meliUserId)}${data.nickname ? ` (${String(data.nickname)})` : ""}.` }
          : { kind: "error", text: String(data.message ?? "Falha ao testar a conexão.") },
      );
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setFeedback(null);
    try {
      const { ok, status, data } = await postJson("/api/mercadolivre/disconnect", { confirm: confirmText });
      if (status === 401) return window.location.assign("/login?next=/configuracoes/integracoes/mercadolivre");
      setFeedback(ok ? { kind: data.revokedRemotely ? "success" : "warn", text: String(data.note) } : { kind: "error", text: String(data.message) });
      if (ok) {
        setConfirming(false);
        setConfirmText("");
        await reload();
      }
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    await postJson("/api/admin/logout");
    window.location.assign("/");
  }

  const connected = summary.status === "connected";

  return (
    <>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}

      <section className="card" aria-labelledby="conn-title">
        <div className="status-row">
          <h2 id="conn-title">Conexão da conta vendedora</h2>
          <span className={`badge ${summary.status}`}>{STATUS_LABEL[summary.status]}</span>
        </div>

        {summary.status === "reauth_required" && (
          <div className="alert warn">
            A autorização expirou ou foi revogada no Mercado Livre{summary.lastErrorCode ? ` (${summary.lastErrorCode})` : ""}. Conecte novamente.
          </div>
        )}

        <dl className="details">
          <div>
            <dt>Conta (user_id)</dt>
            <dd>{summary.meliUserId ?? "—"}</dd>
          </div>
          <div>
            <dt>Vendedor</dt>
            <dd>{summary.nickname ?? "—"}</dd>
          </div>
          <div>
            <dt>Site</dt>
            <dd>{summary.siteId ?? "—"}</dd>
          </div>
          <div>
            <dt>Access Token expira em</dt>
            <dd>{formatDate(summary.accessTokenExpiresAt)}</dd>
          </div>
          <div>
            <dt>Última conexão</dt>
            <dd>{formatDate(summary.lastConnectedAt)}</dd>
          </div>
          <div>
            <dt>Última renovação</dt>
            <dd>{formatDate(summary.lastRefreshedAt)}</dd>
          </div>
        </dl>

        <div className="actions">
          <a className="btn btn-primary" href="/api/auth/mercadolivre">
            {connected ? "Reconectar Mercado Livre" : "Conectar Mercado Livre"}
          </a>
          {connected && (
            <>
              <button className="btn btn-secondary" type="button" onClick={testConnection} disabled={busy !== null}>
                {busy === "test" ? "Testando…" : "Testar conexão (/users/me)"}
              </button>
              <button className="btn btn-danger" type="button" onClick={() => setConfirming(true)} disabled={busy !== null}>
                Desconectar
              </button>
            </>
          )}
        </div>

        {confirming && (
          <div className="confirm-box">
            <p>
              A desconexão tenta revogar a autorização no Mercado Livre e remove os tokens deste integrador. Para confirmar, digite{" "}
              <strong>{DISCONNECT_CONFIRMATION}</strong>.
            </p>
            <label htmlFor="confirm-disconnect">Confirmação</label>
            <input
              id="confirm-disconnect"
              type="text"
              autoComplete="off"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <div className="actions">
              <button
                className="btn btn-danger-solid"
                type="button"
                onClick={disconnect}
                disabled={busy !== null || confirmText !== DISCONNECT_CONFIRMATION}
              >
                {busy === "disconnect" ? "Desconectando…" : "Confirmar desconexão"}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </section>

      <p className="muted">
        As credenciais (Access Token e Refresh Token) ficam apenas no servidor, criptografadas, e nunca são exibidas nesta página.{" "}
        <button className="btn btn-secondary" type="button" onClick={logout} style={{ minHeight: 0, padding: "2px 10px", marginLeft: 6 }}>
          Sair
        </button>
      </p>
    </>
  );
}
