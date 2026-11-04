import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { getCatalogSettings, setDefaultPriceTable, SettingsValidationError } from "@/lib/catalog/settings";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminHandler(async () => jsonNoStore({ settings: await getCatalogSettings(getSql()) }));

const bodySchema = z
  .object({
    code: z.string().trim().min(1).max(10),
    /** Filial de referência; null = menor filial com preço ativo; ausente = mantém a atual. */
    branchId: z.string().trim().min(1).max(10).nullable().optional(),
  })
  .strict();

/** Define a tabela comercial de referência do catálogo. */
export const PATCH = adminHandler(
  async (req) => {
    const body = await parseJsonBody(req, bodySchema);
    if (!body.ok) return body.response;
    try {
      return jsonNoStore({ settings: await setDefaultPriceTable(getSql(), body.data.code, body.data.branchId) });
    } catch (err) {
      if (err instanceof SettingsValidationError) return errorJson(422, err.code, err.message);
      throw err;
    }
  },
  { mutating: true },
);
