import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonNoStore } from "./http";

export function validationError(error: z.ZodError, message = "Dados inválidos"): NextResponse {
  return jsonNoStore(
    {
      error: "validation_error",
      message,
      issues: error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    400,
  );
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** Lê o corpo JSON e valida com Zod. Corpo ausente é tratado como {}. */
export async function parseJsonBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<Parsed<z.infer<S>>> {
  const text = await req.text();
  if (text.length > 256 * 1024) {
    return { ok: false, response: jsonNoStore({ error: "payload_too_large", message: "Corpo da requisição muito grande" }, 413) };
  }
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: jsonNoStore({ error: "invalid_json", message: "JSON inválido" }, 400) };
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: validationError(parsed.error) };
}

export function parseQuery<S extends z.ZodType>(req: NextRequest, schema: S): Parsed<z.infer<S>> {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: validationError(parsed.error, "Parâmetros inválidos") };
}

export const idParam = z.coerce.number().int().positive().max(2_147_483_647);

export async function parseId(params: Promise<Record<string, string>>, key = "id"): Promise<number | null> {
  const value = (await params)[key];
  const parsed = idParam.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Preço monetário informado pelo operador: aceita "89,90" ou "89.90", até 2 casas. Retorna string decimal. */
export const moneyInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(/\s/g, "").replace(",", "."))
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), "Use um valor como 89,90 (até 2 casas decimais)")
  .refine((v) => Number(v) > 0, "O preço deve ser maior que zero");

export const adsProductIdsSchema = z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(5000);
