import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { suggestCategories } from "@/lib/meli/categories";
import { loadProductForSuggestions } from "@/lib/publish/suggestions";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z
  .object({
    q: z.string().trim().min(2).max(200).optional(),
    draftId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(8).default(5),
  })
  .refine((v) => v.q || v.draftId, "Informe q ou draftId");

/** Sugestões do preditor oficial (domain_discovery). Somente sugestões: o operador escolhe. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    let text = q.data.q;
    if (!text && q.data.draftId) {
      const product = await loadProductForSuggestions(getSql(), q.data.draftId);
      if (!product) return errorJson(404, "not_found", "Rascunho não encontrado");
      text = product.name;
    }
    return jsonNoStore({ query: text, suggestions: await suggestCategories(text!, q.data.limit) });
  },
  { rateLimitPerMinute: 60 },
);
