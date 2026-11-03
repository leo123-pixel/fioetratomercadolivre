import { redirect } from "next/navigation";
import { getServerAdminSession } from "@/lib/auth/server-session";
import { ConfigError } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getConnectionSummary, type ConnectionSummary } from "@/lib/meli/connection";
import { messageFor } from "@/lib/meli/messages";
import { ConnectionPanel } from "./ConnectionPanel";

export const dynamic = "force-dynamic";

const PATH = "/configuracoes/integracoes/mercadolivre";

export default async function MercadoLivreSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;

  let session;
  try {
    session = await getServerAdminSession();
  } catch (err) {
    logger.error("Falha ao validar sessão", { err });
    return <ConfigProblem config={err instanceof ConfigError} />;
  }
  if (!session) redirect(`/login?next=${encodeURIComponent(PATH)}`);

  let summary: ConnectionSummary;
  try {
    summary = await getConnectionSummary();
  } catch (err) {
    logger.error("Falha ao carregar conexão do Mercado Livre", { err });
    return <ConfigProblem config={err instanceof ConfigError} />;
  }

  const flash = error ? { kind: "error" as const, text: messageFor(error) } : status ? { kind: "success" as const, text: messageFor(status) } : null;

  return (
    <>
      <p className="breadcrumb">Configurações › Integrações</p>
      <h1>Mercado Livre</h1>
      {flash?.text && (
        <div className={`alert ${flash.kind}`} role={flash.kind === "error" ? "alert" : "status"}>
          {flash.text}
        </div>
      )}
      <ConnectionPanel initial={summary} />
    </>
  );
}

function ConfigProblem({ config }: { config: boolean }) {
  return (
    <div className="alert error" role="alert">
      {config
        ? "Configuração do servidor incompleta. Verifique as variáveis de ambiente (veja .env.example)."
        : "Não foi possível carregar os dados da integração. Verifique a conexão com o banco de dados."}
    </div>
  );
}
