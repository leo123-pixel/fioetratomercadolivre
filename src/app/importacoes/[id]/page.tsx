import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/page-guard";
import { formatDateTime, JOB_STATUS_LABEL, JOB_TYPE_LABEL } from "@/lib/format";
import { getJob, listJobErrors } from "@/lib/imports/jobs";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";

export const dynamic = "force-dynamic";

export default async function ImportJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((await requireAdminPage(`/importacoes/${encodeURIComponent(id)}`)) === "config") return <PageProblem kind="config" />;
  let job, errors;
  try {
    job = await getJob(getSql(), id);
    if (job) errors = await listJobErrors(getSql(), job.id, 500);
  } catch (err) {
    logger.error("Falha ao carregar importação", { err });
    return <PageProblem kind="database" />;
  }
  if (!job || !errors) notFound();
  const status = JOB_STATUS_LABEL[job.status] ?? { text: job.status, tone: "" };
  const scope = job.params.adsProductIds?.length ? `${job.params.adsProductIds.length} produto(s) selecionado(s)` : "Catálogo completo";

  return (
    <>
      <p className="breadcrumb">
        <a href="/importacoes">Importações</a> › {job.id.slice(0, 8)}
      </p>
      <div className="page-head">
        <h1>Importação de {JOB_TYPE_LABEL[job.type]?.toLowerCase() ?? job.type}</h1>
        <span className={`chip ${status.tone}`}>{status.text}</span>
      </div>
      <section className="card">
        <dl className="details">
          <div>
            <dt>Escopo</dt>
            <dd>{scope}</dd>
          </div>
          <div>
            <dt>Processados</dt>
            <dd>
              {job.processed}
              {job.total !== null ? ` de ${job.total}` : ""}
            </dd>
          </div>
          <div>
            <dt>Novos / atualizados / sem mudança</dt>
            <dd>
              {job.created} / {job.updated} / {job.unchanged}
            </dd>
          </div>
          <div>
            <dt>Falhas</dt>
            <dd>{job.failed}</dd>
          </div>
          <div>
            <dt>Criada / iniciada</dt>
            <dd>
              {formatDateTime(job.createdAt)} / {formatDateTime(job.startedAt)}
            </dd>
          </div>
          <div>
            <dt>Concluída</dt>
            <dd>{formatDateTime(job.finishedAt)}</dd>
          </div>
          <div>
            <dt>Posição salva</dt>
            <dd>
              {job.cursor.done ? "todas as páginas percorridas" : job.cursor.page ? `${job.cursor.phase ?? ""} página ${job.cursor.page}` : "início"}
            </dd>
          </div>
          <div>
            <dt>Tentativas na etapa atual</dt>
            <dd>{job.attempts}</dd>
          </div>
        </dl>
        {job.errorSummary && <div className="alert warn" style={{ marginTop: 14, marginBottom: 0 }}>{job.errorSummary}</div>}
        {job.lastError && job.status === "RUNNING" && <p className="hint warn">Último erro: {job.lastError}</p>}
      </section>

      <section className="card">
        <h2>Registros de erro ({errors.total})</h2>
        {errors.total === 0 ? (
          <p className="muted">Nenhum erro registrado.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Código</th>
                  <th className="num">Produto ADS</th>
                  <th className="num">Página</th>
                  <th>Mensagem</th>
                </tr>
              </thead>
              <tbody>
                {errors.items.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.createdAt)}</td>
                    <td>
                      <code>{e.errorCode}</code>
                    </td>
                    <td className="num">{e.externalProductId ?? "—"}</td>
                    <td className="num">{e.page ?? "—"}</td>
                    <td>{e.errorMessage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {errors.total > errors.items.length && <p className="hint">Exibindo os primeiros {errors.items.length} registros.</p>}
      </section>
    </>
  );
}
