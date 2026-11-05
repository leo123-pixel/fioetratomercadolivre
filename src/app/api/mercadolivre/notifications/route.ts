import type { NextRequest } from "next/server";
import { handleMeliWebhook } from "@/lib/marketplace/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * URL antiga de notificações (fase 3), mantida por compatibilidade caso já esteja cadastrada no
 * DevCenter. Usa exatamente o mesmo fluxo persistente de /api/webhooks/mercadolivre (a URL recomendada).
 */
export async function POST(req: NextRequest) {
  return handleMeliWebhook(req);
}
