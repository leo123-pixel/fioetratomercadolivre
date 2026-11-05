import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { AdsApiError, AdsWriteBlockedError } from "./ads/client";
import { SettingsError } from "./ads/commercial";
import { CustomerError } from "./ads/customers";
import { SubmissionError } from "./ads/order-submission";
import { MappingError } from "./marketplace/mappings";
import { getAdminSession } from "./auth/admin";
import { DraftLockedError } from "./catalog/drafts";
import { ConfigError } from "./env";
import { errorJson, isSameOrigin, jsonNoStore } from "./http";
import { logger } from "./logger";
import { MeliHttpError } from "./meli/api";
import { MeliAuthError } from "./meli/tokens";
import { rateLimit } from "./rate-limit";
import { StorageError } from "./storage/supabase";

/** Contexto das rotas dinâmicas do App Router (ex.: { params: Promise<{ id: string }> }). */
export type RouteContext<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

type Wrapped<C> = unknown extends C
  ? (req: NextRequest) => Promise<NextResponse>
  : (req: NextRequest, ctx: C) => Promise<NextResponse>;

export interface AdminHandlerOptions {
  mutating?: boolean;
  /** Limite por janela de 1 minuto para esta rota (por instância). */
  rateLimitPerMinute?: number;
}

/**
 * Envolve handlers administrativos: exige sessão de administrador, valida a origem em
 * métodos que alteram estado e converte erros inesperados em respostas sem detalhes internos.
 */
export function adminHandler<C = unknown>(handler: (req: NextRequest, ctx: C) => Promise<NextResponse>, opts: AdminHandlerOptions = {}): Wrapped<C> {
  return (async (req: NextRequest, ctx?: C): Promise<NextResponse> => {
    try {
      const session = getAdminSession(req);
      if (!session) return errorJson(401, "unauthorized", "Autenticação de administrador necessária");
      if (opts.mutating && !isSameOrigin(req)) return errorJson(403, "forbidden", "Origem da requisição não permitida");
      if (opts.rateLimitPerMinute) {
        const rl = rateLimit(`${req.method}:${req.nextUrl.pathname.replace(/\/\d+(?=\/|$)/g, "/:id")}:${session.sid}`, opts.rateLimitPerMinute, 60_000);
        if (!rl.ok) {
          const res = errorJson(429, "rate_limited", `Muitas requisições. Tente novamente em ${rl.retryAfterSec}s.`);
          res.headers.set("Retry-After", String(rl.retryAfterSec));
          return res;
        }
      }
      return await handler(req, ctx as C);
    } catch (err) {
      logger.error("Erro em endpoint administrativo", { path: req.nextUrl.pathname, err });
      if (err instanceof ConfigError) {
        // Somente para administradores autenticados; a mensagem cita nomes de variáveis, nunca valores.
        return jsonNoStore({ error: "config_error", message: "Configuração do servidor incompleta", detail: err.message }, 500);
      }
      if (err instanceof AdsWriteBlockedError) return jsonNoStore({ error: "ads_write_blocked", message: err.message }, 403);
      if (err instanceof SubmissionError) return jsonNoStore({ error: err.code, message: err.message, details: err.details ?? null }, 409);
      if (err instanceof CustomerError) return jsonNoStore({ error: err.code, message: err.message }, 409);
      if (err instanceof MappingError) return jsonNoStore({ error: err.code, message: err.message }, 409);
      if (err instanceof SettingsError) return jsonNoStore({ error: "invalid_settings", message: "Configuração inválida", issues: err.issues.map((i) => ({ path: i.field, message: i.message })) }, 422);
      if (err instanceof AdsApiError) return jsonNoStore({ error: "ads_error", kind: err.kind, message: err.message }, 502);
      if (err instanceof StorageError) return errorJson(502, "storage_error", err.message);
      if (err instanceof DraftLockedError) return jsonNoStore({ error: "draft_locked", status: err.status, message: err.message }, 409);
      if (err instanceof MeliAuthError) return jsonNoStore({ error: "meli_auth", code: err.code, message: "Conta Mercado Livre não conectada ou autorização expirada. Reconecte em Mercado Livre." }, 409);
      if (err instanceof MeliHttpError) {
        const status = err.kind === "bad_request" || err.kind === "not_found" ? 422 : err.kind === "rate_limited" ? 429 : 502;
        return jsonNoStore({ error: "meli_error", kind: err.kind, message: err.message, causes: err.causes }, status);
      }
      return errorJson(500, "internal_error", "Erro interno");
    }
  }) as Wrapped<C>;
}
