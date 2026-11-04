import "server-only";
import { redirect } from "next/navigation";
import { ConfigError } from "../env";
import { logger } from "../logger";
import { getServerAdminSession } from "./server-session";

/**
 * Exige administrador em páginas (Server Components). Redireciona ao login quando não há sessão.
 * Retorna "config" se a configuração do servidor estiver incompleta (a página mostra um aviso).
 */
export async function requireAdminPage(path: string): Promise<"ok" | "config"> {
  let session;
  try {
    session = await getServerAdminSession();
  } catch (err) {
    logger.error("Falha ao validar sessão", { err });
    if (err instanceof ConfigError) return "config";
    throw err;
  }
  if (!session) redirect(`/login?next=${encodeURIComponent(path)}`);
  return "ok";
}
