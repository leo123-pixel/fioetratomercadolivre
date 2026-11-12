"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";

interface Settings {
  autoSyncEnabled: boolean;
  autoSyncIntervalMin: number;
  autoSyncScope: "ALL_LINKED" | "APPROVED_GROUPS";
  adsHoursStart: string | null;
  adsHoursEnd: string | null;
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

interface PriceAuto {
  settings: { autoSyncEnabled: boolean; autoSyncIntervalMin: number; autoApplyLargeChanges: boolean; maxChangePct: number; priceTableCode: string };
  autoSync: { active: boolean; reason: string | null };
}

export function SettingsPanel(props: {
  settings: Settings;
  envAutoSyncAllowed: boolean;
  autoSync: { active: boolean; reason: string | null };
  price: PriceAuto;
  adsHours: { open: boolean; reason: string | null; label: string };
}) {
  const router = useRouter();
  const s = props.settings;
  const ps = props.price.settings;
  const [priceInterval, setPriceInterval] = useState(String(ps.autoSyncIntervalMin));
  const [hours, setHours] = useState({ start: s.adsHoursStart ?? "", end: s.adsHoursEnd ?? "" });
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

  async function patch(body: Record<string, unknown>, ok: string, url = "/api/stock-sync/settings") {
    setBusy(true);
    const r = await api(url, { method: "PATCH", body });
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

      <h3>Horário de funcionamento da ADS</h3>
      <p className="muted">
        A ADS desliga os servidores fora do expediente. Fora deste horário (horário de Campo Grande/MS) o estoque e o preço automáticos ficam em pausa e
        retomam sozinhos quando a janela abre. Deixe os dois campos vazios para não limitar.
      </p>
      <ul className="muted">
        <li>
          Horário: {props.adsHours.label} — agora: {props.adsHours.open ? "dentro do horário" : "fora do horário (automação em pausa)"}
        </li>
      </ul>
      <div className="form-grid">
        <label>
          ADS liga às
          <input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} />
        </label>
        <label>
          ADS desliga às
          <input type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} />
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => patch({ adsHoursStart: hours.start || null, adsHoursEnd: hours.end || null }, "Horário da ADS salvo")}
        >
          Salvar horário
        </button>
      </div>

      <h3>Estoque automático</h3>
      <p className="muted">
        A cada intervalo o sistema lê o saldo da ADS e grava a diferença no Mercado Livre, conferindo depois. Anúncios Full, kits incompletos e anúncios com
        problema ficam de fora (aparecem na lista com o motivo).
      </p>
      <ul className="muted">
        <li>Ambiente (STOCK_AUTO_SYNC_ENABLED): {props.envAutoSyncAllowed ? "liberado" : "bloqueado"}</li>
        <li>Homologação: {s.homologatedAt ? `registrada por ${s.homologatedBy} em ${formatDateTime(s.homologatedAt)}` : "não registrada"}</li>
        <li>
          Situação:{" "}
          {props.autoSync.active
            ? `ativa a cada ${s.autoSyncIntervalMin} min (${s.autoSyncScope === "APPROVED_GROUPS" ? "só produtos aprovados" : "todos os anúncios vinculados"})`
            : `desativada — ${props.autoSync.reason}`}
        </li>
      </ul>
      <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={s.autoSyncScope !== "APPROVED_GROUPS"}
          disabled={busy}
          onChange={(e) =>
            patch({ autoSyncScope: e.target.checked ? "ALL_LINKED" : "APPROVED_GROUPS" }, e.target.checked ? "Automação vale para todos os anúncios vinculados" : "Automação só para produtos aprovados")
          }
        />
        Atualizar todos os anúncios vinculados (desmarcado: só os produtos aprovados um a um)
      </label>
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

      <h3>Preço automático (anúncios legados)</h3>
      <p className="muted">
        A cada intervalo o sistema compara o preço da tabela {ps.priceTableCode} da ADS com o do Mercado Livre e aplica a diferença, com as mesmas travas da
        aprovação manual: anúncio em promoção, kit, preço ausente ou zerado ficam de fora.
      </p>
      <ul className="muted">
        <li>Situação: {props.price.autoSync.active ? `ativa a cada ${ps.autoSyncIntervalMin} min` : `desativada — ${props.price.autoSync.reason}`}</li>
      </ul>
      <div className="form-grid">
        <label>
          Intervalo do preço (min)
          <input type="text" inputMode="numeric" value={priceInterval} onChange={(e) => setPriceInterval(e.target.value)} />
          <span className="hint">Mínimo 15.</span>
        </label>
      </div>
      <label style={{ display: "flex", gap: 8, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={ps.autoApplyLargeChanges}
          disabled={busy}
          onChange={(e) => patch({ autoApplyLargeChanges: e.target.checked }, "Configuração de preço salva", "/api/price-sync/settings")}
        />
        Aplicar também mudanças acima de {ps.maxChangePct}% (desmarcado: essas ficam esperando o botão Aprovar)
      </label>
      <div className="actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => patch({ autoSyncIntervalMin: Number(priceInterval) }, "Intervalo do preço salvo", "/api/price-sync/settings")}
        >
          Salvar intervalo
        </button>
        {ps.autoSyncEnabled ? (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => patch({ autoSyncEnabled: false }, "Preço automático desativado", "/api/price-sync/settings")}>
            Desativar preço automático
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !props.envAutoSyncAllowed}
            onClick={() => patch({ autoSyncEnabled: true, autoSyncIntervalMin: Number(priceInterval) }, "Preço automático ativado", "/api/price-sync/settings")}
          >
            Ativar preço automático
          </button>
        )}
      </div>
    </section>
  );
}
