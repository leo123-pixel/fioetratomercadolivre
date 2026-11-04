import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { jsonNoStore } from "@/lib/http";
import { CATEGORY_ID, getCategory, getRootCategories } from "@/lib/meli/categories";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ parent: z.string().regex(CATEGORY_ID).optional() });

/** Navegação pela árvore: sem `parent` lista a raiz do MLB; com `parent`, a categoria e suas filhas. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const sql = getSql();
    if (!q.data.parent) return jsonNoStore({ parent: null, path: [], children: await getRootCategories(sql) });
    const c = await getCategory(sql, q.data.parent);
    return jsonNoStore({
      parent: { id: c.id, name: c.name, leaf: c.children_categories.length === 0, listingAllowed: c.settings.listing_allowed !== false },
      path: c.path_from_root,
      children: c.children_categories.map((x) => ({ id: x.id, name: x.name })),
    });
  },
  { rateLimitPerMinute: 120 },
);
