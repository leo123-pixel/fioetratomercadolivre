import type { NextRequest } from "next/server";
import { handleMeliWebhook } from "@/lib/marketplace/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Notificações do Mercado Livre (URL a cadastrar no DevCenter). Ver lib/marketplace/webhook.ts. */
export async function POST(req: NextRequest) {
  return handleMeliWebhook(req);
}
