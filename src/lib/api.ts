import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { AdsApiError } from "./ads/client";
import { getAdminSession } from "./auth/admin";
import { ConfigError } from "./env";
import { errorJson, isSameOrigin, jsonNoStore } from "./http";
import { logger } from "./logger";
import { StorageError } from "./storage/supabase";

/** Contexto das rotas dinâmicas do App Router (ex.: { params: Promise<{ id: string }> }). */
export type RouteContext<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

/**
 * Envolve handlers administrativos: exige sessão de administrador, valida a origem em
 * métodos que alteram estado e converte erros inesperados em respostas sem detalhes internos.
 */
type Wrapped<C> = unknown extends C
  ? (req: NextRequest) => Promise<NextResponse>
  : (req: NextRequest, ctx: C) => Promise<NextResponse>;

export function adminHandler<C = unknown>(handler: (req: NextRequest, ctx: C) => Promise<NextResponse>, opts: { mutating?: boolean } = {}): Wrapped<C> {
  return (async (req: NextRequest, ctx?: C): Promise<NextResponse> => {
    try {
      if (!getAdminSession(req)) return errorJson(401, "unauthorized", "Autenticação de administrador necessária");
      if (opts.mutating && !isSameOrigin(req)) return errorJson(403, "forbidden", "Origem da requisição não permitida");
      return await handler(req, ctx as C);
    } catch (err) {
      logger.error("Erro em endpoint administrativo", { path: req.nextUrl.pathname, err });
      if (err instanceof ConfigError) {
        // Somente para administradores autenticados; a mensagem cita nomes de variáveis, nunca valores.
        return jsonNoStore({ error: "config_error", message: "Configuração do servidor incompleta", detail: err.message }, 500);
      }
      if (err instanceof AdsApiError) return jsonNoStore({ error: "ads_error", kind: err.kind, message: err.message }, 502);
      if (err instanceof StorageError) return errorJson(502, "storage_error", err.message);
      return errorJson(500, "internal_error", "Erro interno");
    }
  }) as Wrapped<C>;
}
