"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { formatDateTime, JOB_STATUS_LABEL, JOB_TYPE_LABEL } from "@/lib/format";
import type { JobView } from "../produtos/ImportControls";

const ACTIVE = new Set(["PENDING", "RUNNING"]);

export function JobHistory({ initial }: { initial: JobView[] }) {
  const [jobs, setJobs] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ items: JobView[] }>("/api/import/jobs?limit=50");
    if (r.ok) setJobs(r.data.items);
  }, []);

  const anyActive = jobs.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [anyActive, load]);

  async function start(kind: string) {
    setBusy(kind);
    setFeedback(null);
    try {
      const r = await api(`/api/import/${kind}`, { body: {} });
      if (r.status === 409) setFeedback({ kind: "warn", text: r.data.message ?? "Já existe uma importação em andamento." });
      else if (!r.ok) setFeedback({ kind: "error", text: errorText(r) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function act(job: JobView, action: "retry" | "cancel") {
    setBusy(job.id);
    setFeedback(null);
    try {
      const r = await api<{ resumed?: boolean }>(`/api/import/jobs/${job.id}/${action}`, { body: {} });
      if (!r.ok) setFeedback({ kind: r.status === 409 ? "warn" : "error", text: errorText(r) });
      else if (action === "retry") setFeedback({ kind: "success", text: r.data.resumed ? "Importação retomada do ponto salvo." : "Nova importação criada com os mesmos parâmetros." });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn btn-primary" type="button" disabled={busy !== null} onClick={() => start("products")}>
          Importar produtos
        </button>
        <button className="btn btn-secondary" type="button" disabled={busy !== null} onClick={() => start("price-tables")}>
          Importar tabelas comerciais
        </button>
        <button className="btn btn-secondary" type="button" disabled={busy !== null} onClick={() => start("prices")}>
          Atualizar preços
        </button>
        <button className="btn btn-secondary" type="button" disabled={busy !== null} onClick={() => start("stocks")}>
          Atualizar estoque
        </button>
      </div>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status">
          {feedback.text}
        </div>
      )}
      {jobs.length === 0 ? (
        <div className="card empty-state">Nenhuma importação executada ainda.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Situação</th>
                <th className="num">Processados</th>
                <th className="num">Novos</th>
                <th className="num">Atualizados</th>
                <th className="num">Sem mudança</th>
                <th className="num">Falhas</th>
                <th>Início</th>
                <th>Fim</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const status = JOB_STATUS_LABEL[j.status] ?? { text: j.status, tone: "" };
                const pct = j.total ? Math.min(100, Math.round((j.processed / j.total) * 100)) : null;
                return (
                  <tr key={j.id}>
                    <td>
                      <a href={`/importacoes/${j.id}`}>{JOB_TYPE_LABEL[j.type] ?? j.type}</a>
                      {j.errorSummary && <small className="hint warn" style={{ display: "block", maxWidth: 360 }}>{j.errorSummary}</small>}
                    </td>
                    <td>
                      <span className={`chip ${status.tone}`}>{status.text}</span>
                      {ACTIVE.has(j.status) && (
                        <div className="progress" style={{ marginTop: 6, minWidth: 100 }}>
                          <span style={{ width: `${pct ?? 5}%` }} />
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {j.processed}
                      {j.total !== null ? ` / ${j.total}` : ""}
                    </td>
                    <td className="num">{j.created}</td>
                    <td className="num">{j.updated}</td>
                    <td className="num">{j.unchanged}</td>
                    <td className="num">{j.failed}</td>
                    <td>{formatDateTime(j.createdAt)}</td>
                    <td>{formatDateTime(j.finishedAt)}</td>
                    <td>
                      <div className="toolbar">
                        {ACTIVE.has(j.status) ? (
                          <button className="btn btn-danger btn-sm" type="button" disabled={busy !== null} onClick={() => act(j, "cancel")}>
                            Cancelar
                          </button>
                        ) : (
                          <button className="btn btn-secondary btn-sm" type="button" disabled={busy !== null} onClick={() => act(j, "retry")}>
                            {j.status === "COMPLETED" ? "Reexecutar" : "Retomar"}
                          </button>
                        )}
                        <a className="btn btn-secondary btn-sm" href={`/importacoes/${j.id}`}>
                          Detalhes
                        </a>
                      </div>
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
