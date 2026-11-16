import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/admin";
import { requesterFromSession } from "@/lib/publish/service";

/** Identificação do administrador para auditoria (nunca o token da sessão). */
export const actorOf = (req: NextRequest) => requesterFromSession(getAdminSession(req)?.sid);
