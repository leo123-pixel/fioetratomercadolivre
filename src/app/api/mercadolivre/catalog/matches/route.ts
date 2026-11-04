import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { searchCatalog } from "@/lib/meli/catalog";
import { loadProductForSuggestions } from "@/lib/publish/suggestions";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z
  .object({
    draftId: z.coerce.number().int().positive().optional(),
    gtin: z.string().regex(/^\d{8,14}$/).optional(),
    q: z.string().trim().min(3).max(120).optional(),
  })
  .refine((v) => v.draftId || v.gtin || v.q, "Informe draftId, gtin ou q");

/** Possíveis produtos de catálogo (por GTIN ou texto). Informativo: nada é vinculado automaticamente. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    let gtin = q.data.gtin ?? null;
    let text = q.data.q ?? null;
    if (q.data.draftId && !gtin && !text) {
      const product = await loadProductForSuggestions(getSql(), q.data.draftId);
      if (!product) return errorJson(404, "not_found", "Rascunho não encontrado");
      gtin = product.ean;
      text = product.name;
    }
    let result = await searchCatalog({ gtin });
    if (!result.matches.length && text) result = await searchCatalog({ q: text });
    return jsonNoStore(result);
  },
  { rateLimitPerMinute: 30 },
);
