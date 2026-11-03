import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "./auth/admin";
import { ConfigError } from "./env";
import { errorJson, isSameOrigin } from "./http";
import { logger } from "./logger";

/**
 * Envolve handlers administrativos: exige sessão de administrador, valida a origem em
 * métodos que alteram estado e converte erros inesperados em respostas sem detalhes internos.
 */
export function adminHandler(handler: (req: NextRequest) => Promise<NextResponse>, opts: { mutating?: boolean } = {}) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      if (!getAdminSession(req)) return errorJson(401, "unauthorized", "Autenticação de administrador necessária");
      if (opts.mutating && !isSameOrigin(req)) return errorJson(403, "forbidden", "Origem da requisição não permitida");
      return await handler(req);
    } catch (err) {
      logger.error("Erro em endpoint administrativo", { path: req.nextUrl.pathname, err });
      if (err instanceof ConfigError) return errorJson(500, "config_error", "Configuração do servidor incompleta");
      return errorJson(500, "internal_error", "Erro interno");
    }
  };
}
