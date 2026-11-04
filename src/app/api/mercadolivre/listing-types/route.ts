import { z } from "zod";
import { adminHandler } from "@/lib/api";
import { errorJson, jsonNoStore } from "@/lib/http";
import { getCapabilities } from "@/lib/meli/capabilities";
import { CATEGORY_ID, getAvailableListingTypes } from "@/lib/meli/categories";
import { getSql } from "@/lib/sql";
import { parseQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ categoryId: z.string().regex(CATEGORY_ID) });

/** Tipos de anúncio disponíveis para a conta conectada na categoria. */
export const GET = adminHandler(
  async (req) => {
    const q = parseQuery(req, query);
    if (!q.ok) return q.response;
    const caps = await getCapabilities(getSql());
    if (!caps.connected || !caps.meliUserId) return errorJson(409, "not_connected", "Conta Mercado Livre não conectada");
    return jsonNoStore({ listingTypes: await getAvailableListingTypes(caps.meliUserId, q.data.categoryId) });
  },
  { rateLimitPerMinute: 60 },
);
