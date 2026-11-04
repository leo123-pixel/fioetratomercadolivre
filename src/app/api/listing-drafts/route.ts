import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { draftCreateSchema } from "@/lib/catalog/draft-schemas";
import { createDrafts, DRAFT_STATUSES, DRAFT_TABS, listDrafts } from "@/lib/catalog/drafts";
import { listProducts } from "@/lib/catalog/products";
import { parseProductQuery } from "@/lib/catalog/query";
import { jsonNoStore } from "@/lib/http";
import { getSql } from "@/lib/sql";
import { parseJsonBody, parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query = z.object({
  status: z.enum(DRAFT_STATUSES).optional(),
  tab: z.enum(Object.keys(DRAFT_TABS) as [string, ...string[]]).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET = adminHandler(async (req) => {
  const q = parseQuery(req, query);
  if (!q.ok) return q.response;
  return jsonNoStore(await listDrafts(getSql(), { ...q.data, statuses: q.data.tab ? DRAFT_TABS[q.data.tab] : undefined }));
});

/**
 * Cria rascunhos para um produto, uma seleção ou todos os resultados de um filtro (com confirmação e a
 * contagem exibida ao usuário). Ignora inativos e produtos que já têm rascunho/anúncio. Não publica nada.
 */
export const POST = adminHandler(
  async (req) => {
    const body = await parseJsonBody(req, draftCreateSchema);
    if (!body.ok) return body.response;
    const sql = getSql();
    let ids: number[];
    if (body.data.filter) {
      const filters = parseProductQuery(body.data.filter);
      ids = [];
      for (let page = 1; ; page++) {
        const r = await listProducts(sql, { ...filters, page, pageSize: 100 });
        if (page === 1 && r.total !== body.data.expectedCount) {
          return jsonNoStore({ error: "selection_changed", message: `O filtro agora retorna ${r.total} produtos (confirmados: ${body.data.expectedCount}). Revise e confirme novamente.`, total: r.total }, 409);
        }
        ids.push(...r.items.map((i) => i.id));
        if (ids.length >= r.total || !r.items.length) break;
      }
    } else {
      ids = body.data.productIds ?? [body.data.productId!];
    }
    const result = await createDrafts(sql, ids);
    return jsonNoStore(result, result.created.length ? 201 : 200);
  },
  { mutating: true, rateLimitPerMinute: 30 },
);
