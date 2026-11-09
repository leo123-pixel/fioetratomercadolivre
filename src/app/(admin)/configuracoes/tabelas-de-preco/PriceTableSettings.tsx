"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";

interface TableView {
  code: string;
  description: string;
  base: string | null;
  expense: string | null;
  commission: string | null;
  profit: string | null;
  freight: string | null;
  markup: string | null;
  isNormal: boolean;
  inactive: boolean;
  adsUpdatedAt: string | null;
  updatedAt: string;
  activePrices: number;
}

export function PriceTableSettings({
  tables,
  settings,
  branches,
}: {
  tables: TableView[];
  settings: { defaultPriceTable: string | null; defaultBranchId: string | null };
  branches: string[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(settings);
  const [branch, setBranch] = useState(settings.defaultBranchId ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);

  async function choose(code: string) {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api<{ settings: typeof settings }>("/api/settings/default-price-table", { method: "PATCH", body: { code, branchId: branch || null } });
      if (!r.ok) return setFeedback({ kind: "error", text: errorText(r) });
      setCurrent(r.data.settings);
      setFeedback({ kind: "success", text: `Tabela ${code} definida como referência.` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function importTables() {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api("/api/import/price-tables", { body: {} });
      if (r.status === 409) setFeedback({ kind: "warn", text: r.data.message ?? "Importação já em andamento." });
      else if (!r.ok) setFeedback({ kind: "error", text: errorText(r) });
      else setFeedback({ kind: "success", text: "Importação das tabelas enviada. Acompanhe em Importações e recarregue esta página." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="form-grid" style={{ alignItems: "end" }}>
          <div>
            <label htmlFor="branch">Filial de referência</label>
            <select id="branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">Menor filial com preço ativo</option>
              {branches.map((b) => (
                <option key={b} value={b}>
                  Filial {b}
                </option>
              ))}
            </select>
            <p className="hint">Aplicada ao clicar em “Usar como referência”.</p>
          </div>
          <div className="toolbar">
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={importTables}>
              Importar tabelas da ADS
            </button>
          </div>
        </div>
      </div>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}
      {tables.length === 0 ? (
        <div className="card empty-state">Nenhuma tabela importada. Use “Importar tabelas da ADS” (ou “Atualizar preços”, que também importa as tabelas).</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Código</th>
                <th>Descrição</th>
                <th>Base</th>
                <th className="num">Despesa</th>
                <th className="num">Comissão</th>
                <th className="num">Lucro</th>
                <th className="num">Frete</th>
                <th className="num">Majoração</th>
                <th className="num">Preços ativos</th>
                <th>Situação</th>
                <th>Atualizada na ADS</th>
                <th>Referência</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => {
                const isRef = current.defaultPriceTable === t.code;
                return (
                  <tr key={t.code} className={isRef ? "selected" : undefined}>
                    <td>
                      <strong>{t.code}</strong>
                    </td>
                    <td>
                      {t.description}
                      {t.isNormal && <span className="chip" style={{ marginLeft: 6 }}>normal na ADS</span>}
                    </td>
                    <td>{t.base ?? "—"}</td>
                    <td className="num">{formatPercent(t.expense)}</td>
                    <td className="num">{formatPercent(t.commission)}</td>
                    <td className="num">{formatPercent(t.profit)}</td>
                    <td className="num">{formatPercent(t.freight)}</td>
                    <td className="num">{formatPercent(t.markup)}</td>
                    <td className="num">{formatNumber(t.activePrices)}</td>
                    <td>{t.inactive ? <span className="chip danger">Inativa</span> : <span className="chip ok">Ativa</span>}</td>
                    <td>{formatDateTime(t.adsUpdatedAt)}</td>
                    <td>
                      {isRef ? (
                        <span className="chip info">Referência{current.defaultBranchId ? ` · filial ${current.defaultBranchId}` : ""}</span>
                      ) : (
                        <button className="btn btn-secondary btn-sm" type="button" disabled={busy || t.inactive} onClick={() => choose(t.code)}>
                          Usar como referência
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
