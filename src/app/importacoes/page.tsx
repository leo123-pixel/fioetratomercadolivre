import { requireAdminPage } from "@/lib/auth/page-guard";
import { listJobs } from "@/lib/imports/jobs";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../PageProblem";
import type { JobView } from "../produtos/ImportControls";
import { JobHistory } from "./JobHistory";

export const dynamic = "force-dynamic";

export default async function ImportacoesPage() {
  if ((await requireAdminPage("/importacoes")) === "config") return <PageProblem kind="config" />;
  let jobs;
  try {
    jobs = await listJobs(getSql(), { limit: 50 });
  } catch (err) {
    logger.error("Falha ao carregar importações", { err });
    return <PageProblem kind="database" />;
  }
  const initial: JobView[] = jobs.items.map((j) => ({
    ...j,
    createdAt: new Date(j.createdAt).toISOString(),
    finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null,
  }));
  return (
    <>
      <p className="breadcrumb">Catálogo ADS</p>
      <h1>Importações</h1>
      <p className="muted">
        Importações rodam em segundo plano, uma por vez, em lotes de páginas com retentativa automática. Se forem interrompidas, use “Retomar”
        para continuar do ponto salvo. Nenhuma importação altera dados na ADS ou publica anúncios.
      </p>
      <JobHistory initial={initial} />
    </>
  );
}
