"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

interface Settings {
  autoSyncEnabled: boolean;
  autoSyncIntervalMin: number;
  maxStockAgeMinutes: number;
  defaultSafetyReserve: number;
  branchIds: string[] | null;
  pendingOrderWindowDays: number;
  maxJobsPerRun: number;
  stockSourceConfirmed: boolean;
  stockSourceConfirmedBy: string | null;
  stockSourceConfirmedAt: string | null;
  homologatedAt: string | null;
  homologatedBy: string | null;
}

export function SettingsPanel(props: { settings: Settings; envAutoSyncAllowed: boolean; autoSync: { active: boolean; reason: string | null } }) {
  const router = useRouter();
  const s = props.settings;
  const [form, setForm] = useState({
    defaultSafetyReserve: String(s.defaultSafetyReserve),
    maxStockAgeMinutes: String(s.maxStockAgeMinutes),
    pendingOrderWindowDays: String(s.pendingOrderWindowDays),
    maxJobsPerRun: String(s.maxJobsPerRun),
    autoSyncIntervalMin: String(s.autoSyncIntervalMin),
    branchIds: (s.branchIds ?? []).join(", "),
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function patch(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    const r = await api("/api/stock-sync/settings", { method: "PATCH", body });
    setBusy(false);
    if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
    setFeedback({ kind: "success", text: ok });
    router.refresh();
  }

  const save = () =>
    patch(
      {
        defaultSafetyReserve: Number(form.defaultSafetyReserve),
        maxStockAgeMinutes: Number(form.maxStockAgeMinutes),
        pendingOrderWindowDays: Number(form.pendingOrderWindowDays),
        maxJobsPerRun: Number(form.maxJobsPerRun),
        autoSyncIntervalMin: Number(form.autoSyncIntervalMin),
        branchIds: form.branchIds.trim()
          ? form.branchIds
              .split(/[,\s]+/)
              .map((x) => x.trim())
              .filter(Boolean)
          : null,
      },
      "Configurações salvas",
    );

  const field = (key: keyof typeof form, label: string, hint: string) => (
    <label>
      {label}
      <input type="text" inputMode="numeric" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      <span className="hint">{hint}</span>
    </label>
  );

  return (
    <section aria-label="Configurações da sincronização de estoque" className="card">
      <h2 style={{ marginTop: 0 }}>Configurações de estoque</h2>
      {feedback && <div className={`alert ${feedback.kind}`}>{feedback.text}</div>}
      <div className="form-grid">
        {field("defaultSafetyReserve", "Reserva de segurança padrão (un.)", "Descontada do saldo ADS de cada produto (cada grupo pode ter a sua).")}
        {field("maxStockAgeMinutes", "Idade máxima do saldo para aumentar (min)", "Aumentos exigem saldo ADS recente.")}
        {field("pendingOrderWindowDays", "Janela de pedidos pendentes (dias)", "Pedidos do ML ainda não enviados à ADS são descontados.")}
        {field("maxJobsPerRun", "Máximo de atualizações por vez", "Limita cada sincronização manual ou automática.")}
        {field("branchIds", "Filiais ADS consideradas", "Ex.: 01, 02. Vazio = todas as devolvidas pela ADS.")}
        {field("autoSyncIntervalMin", "Intervalo da automação (min)", "Usado somente quando a automação estiver ativa.")}
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
          Salvar configurações
        </button>
      </div>

      <h3>Origem do saldo</h3>
      <p className="muted">
        Confirme somente depois de verificar que o saldo de <code>/estoques</code> da ADS já desconta reservas e movimentações (estoque efetivamente vendável).
      </p>
      <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.stockSourceConfirmed}
          disabled={busy}
          onChange={(e) => patch({ stockSourceConfirmed: e.target.checked }, e.target.checked ? "Origem do saldo confirmada" : "Confirmação removida (aplicação bloqueada)")}
        />
        O saldo da ADS corresponde ao estoque vendável
        {s.stockSourceConfirmed && s.stockSourceConfirmedAt && (
          <span className="muted">
            {" "}
            — por {s.stockSourceConfirmedBy} em {formatDateTime(s.stockSourceConfirmedAt)}
          </span>
        )}
      </label>

      <h3>Sincronização automática</h3>
      <ul className="muted">
        <li>Ambiente (STOCK_AUTO_SYNC_ENABLED): {props.envAutoSyncAllowed ? "liberado" : "bloqueado"}</li>
        <li>Homologação: {s.homologatedAt ? `registrada por ${s.homologatedBy} em ${formatDateTime(s.homologatedAt)}` : "não registrada"}</li>
        <li>Situação: {props.autoSync.active ? "ativa (somente grupos aprovados)" : `desativada — ${props.autoSync.reason}`}</li>
      </ul>
      <div className="actions">
        {!s.homologatedAt && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => patch({ homologate: true }, "Homologação registrada")}>
            Registrar homologação do fluxo
          </button>
        )}
        {s.autoSyncEnabled ? (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => patch({ autoSyncEnabled: false }, "Automação desativada")}>
            Desativar automação
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !props.envAutoSyncAllowed || !s.homologatedAt || !s.stockSourceConfirmed} onClick={() => patch({ autoSyncEnabled: true }, "Automação ativada")}>
            Ativar automação
          </button>
        )}
      </div>
    </section>
  );
}
