"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { JOB_STATUS_LABEL, JOB_TYPE_LABEL } from "@/lib/format";

export interface JobView {
  id: string;
  type: string;
  status: string;
  total: number | null;
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  attempts: number;
  lastError: string | null;
  errorSummary: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const ACTIVE = new Set(["PENDING", "RUNNING"]);

export function JobProgress({ job }: { job: JobView }) {
  const status = JOB_STATUS_LABEL[job.status] ?? { text: job.status, tone: "" };
  const pct = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : null;
  return (
    <div className="job-line">
      <div className="row">
        <strong>{JOB_TYPE_LABEL[job.type] ?? job.type}</strong>
        <span className={`chip ${status.tone}`}>{status.text}</span>
      </div>
      {ACTIVE.has(job.status) && (
        <div className="progress" aria-label="Progresso" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct ?? 5}%` }} />
        </div>
      )}
      <span className="muted">
        {job.processed}
        {job.total !== null ? ` de ${job.total}` : ""} processados · {job.created} novos · {job.updated} atualizados · {job.failed} falhas
        {job.attempts > 0 && job.lastError ? ` · nova tentativa (${job.attempts}) após: ${job.lastError}` : ""}
      </span>
      {job.errorSummary && <span className="hint warn">{job.errorSummary}</span>}
    </div>
  );
}

/** Botões de importação + progresso das tarefas ativas (consulta a cada 3 s enquanto houver tarefa ativa). */
export function ImportControls({ hasProducts }: { hasProducts: boolean }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "warn" | "success"; text: string } | null>(null);
  const activeBefore = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const r = await api<{ items: JobView[] }>("/api/import/jobs?limit=6");
    if (!r.ok) return;
    const items = r.data.items;
    const active = new Set(items.filter((j) => ACTIVE.has(j.status)).map((j) => j.id));
    const finished = [...activeBefore.current].some((id) => !active.has(id));
    activeBefore.current = active;
    setJobs(items);
    if (finished) router.refresh();
  }, [router]);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("import-jobs-changed", onChange);
    return () => window.removeEventListener("import-jobs-changed", onChange);
  }, [load]);

  const anyActive = jobs.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [anyActive, load]);

  async function start(kind: "products" | "prices" | "stocks") {
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

  const visible = jobs.filter((j) => ACTIVE.has(j.status));

  return (
    <div style={{ minWidth: 280, flex: "1 1 420px", maxWidth: 640 }}>
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" type="button" onClick={() => start("products")} disabled={busy !== null}>
          {busy === "products" ? "Enviando…" : "Importar produtos"}
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => start("prices")} disabled={busy !== null || !hasProducts} title={hasProducts ? undefined : "Importe os produtos primeiro"}>
          Atualizar preços
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => start("stocks")} disabled={busy !== null || !hasProducts} title={hasProducts ? undefined : "Importe os produtos primeiro"}>
          Atualizar estoque
        </button>
        <a className="btn btn-secondary" href="/importacoes">
          Histórico
        </a>
      </div>
      {feedback && (
        <div className={`alert ${feedback.kind}`} role="status" style={{ marginTop: 10, marginBottom: 0 }}>
          {feedback.text}
        </div>
      )}
      {visible.length > 0 && (
        <div className="card" style={{ marginTop: 10, marginBottom: 0, padding: "4px 14px" }} aria-live="polite">
          {visible.map((j) => (
            <JobProgress key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}
