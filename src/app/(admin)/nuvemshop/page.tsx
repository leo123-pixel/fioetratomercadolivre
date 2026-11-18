import { requireAdminPage } from "@/lib/auth/page-guard";
import { logger } from "@/lib/logger";
import { connectionView } from "@/lib/nuvemshop/connection";
import { NUVEMSHOP_CALLBACK_PATH } from "@/lib/nuvemshop/env";
import { listImportJobs } from "@/lib/nuvemshop/import";
import { dashboardSummary } from "@/lib/nuvemshop/queries";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../PageProblem";
import { NuvemshopDashboard } from "./NuvemshopDashboard";
import { NuvemshopTabs } from "./NuvemshopTabs";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  connected: "Loja Nuvemshop conectada. Agora importe o catálogo.",
  reconnected: "Loja Nuvemshop reconectada: o token anterior foi substituído.",
  unauthorized: "Sessão expirada durante a conexão. Entre de novo e clique em Conectar loja.",
  forbidden: "Conexão iniciada fora do painel. Use o botão Conectar loja.",
  missing_state: "A Nuvemshop voltou sem o código de segurança (state). Inicie a conexão pelo botão Conectar loja do integrador.",
  invalid_state: "Código de segurança inválido ou expirado (10 minutos). Tente de novo pelo botão Conectar loja.",
  access_denied: "A autorização foi recusada na Nuvemshop.",
  authorization_error: "A Nuvemshop retornou erro na autorização.",
  missing_code: "A Nuvemshop não enviou o código de autorização.",
  token_exchange_failed: "Não foi possível trocar o código pelo token (verifique NUVEMSHOP_APP_ID e NUVEMSHOP_CLIENT_SECRET).",
  store_verification_failed: "O token foi emitido, mas a consulta à loja (GET /store) falhou. Nada foi gravado.",
  store_mismatch: "A loja retornada pela API não confere com a autorização. Nada foi gravado.",
  insufficient_scope: "O aplicativo não tem as permissões necessárias. Ajuste os escopos no Portal de Parceiros e reinstale.",
  other_store_connected: "Já existe outra loja conectada. Desconecte-a antes de conectar uma loja diferente.",
  config_error: "Integração Nuvemshop não configurada no servidor (variáveis NUVEMSHOP_*).",
  internal_error: "Erro interno ao conectar a loja.",
};

export default async function NuvemshopPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string; detail?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/nuvemshop")) === "config") return <PageProblem kind="config" />;
  let summary, view, jobs;
  try {
    const sql = getSql();
    [summary, view, jobs] = await Promise.all([dashboardSummary(sql), connectionView(sql), listImportJobs(sql, 10)]);
  } catch (err) {
    logger.error("Falha ao carregar o painel Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  const flashKey = sp.error ?? sp.status;
  const flash = flashKey ? { kind: sp.error ? "error" : "success", text: `${MESSAGES[flashKey] ?? "Operação concluída."}${sp.detail ? ` (${sp.detail})` : ""}` } : null;
  return (
    <>
      <div className="page-head">
        <h1>Nuvemshop</h1>
        <span className="muted">Integração Fase 1 · Admin API 2025-03</span>
      </div>
      {flash && (
        <div className={`alert ${flash.kind}`} role={flash.kind === "error" ? "alert" : "status"}>
          {flash.text}
        </div>
      )}
      <NuvemshopTabs current="overview" />
      <NuvemshopDashboard
        summary={JSON.parse(JSON.stringify(summary))}
        view={JSON.parse(JSON.stringify(view))}
        jobs={JSON.parse(JSON.stringify(jobs))}
        callbackPath={NUVEMSHOP_CALLBACK_PATH}
      />
    </>
  );
}
