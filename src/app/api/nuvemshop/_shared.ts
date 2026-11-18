import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/admin";
import { requesterFromSession } from "@/lib/publish/service";
import type { Sql } from "@/lib/sql";
import { getLatestStore, NuvemshopNotConnectedError } from "@/lib/nuvemshop/store";

/** Identificação do administrador para auditoria (nunca o token da sessão). */
export const actorOf = (req: NextRequest) => requesterFromSession(getAdminSession(req)?.sid);

/** Loja do catálogo (conectada ou a última conectada, para consulta do histórico). */
export async function catalogStoreId(sql: Sql): Promise<string> {
  const s = await getLatestStore(sql);
  if (!s) throw new NuvemshopNotConnectedError();
  return s.storeId;
}

/** Ações que dependem da loja conectada agora. */
export async function connectedStoreId(sql: Sql): Promise<string> {
  const s = await getLatestStore(sql);
  if (!s || s.connectionStatus === "DISCONNECTED") throw new NuvemshopNotConnectedError();
  return s.storeId;
}

export const isVariantId = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);
