import { after, type NextRequest, NextResponse } from "next/server";
import { parseItemNotification, processItemNotification } from "@/lib/publish/notifications";
import { rateLimit } from "@/lib/rate-limit";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recebe notificações do Mercado Livre. Responde 200 na hora (o ML exige resposta rápida e
 * reenvia em caso de falha); a releitura do anúncio roda depois, via after(). Ver lib/publish/notifications.
 */
export async function POST(req: NextRequest) {
  if (!rateLimit("meli-notifications", 600, 60_000).ok) return new NextResponse(null, { status: 429 });
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // corpo inválido: ignora
  }
  const n = parseItemNotification(body);
  if (n) after(() => processItemNotification(getSql(), n).then(() => undefined));
  return new NextResponse(null, { status: 200 });
}
