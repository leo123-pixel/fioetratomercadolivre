"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/client-api";

const INTERVAL_MS = 60_000;

/**
 * Atualização VISUAL das telas com anúncios: a cada minuto consulta só o banco local
 * (GET /api/marketplace/listings/changes) e recarrega os dados da página quando algo mudou
 * (status, preço, quantidade ou divergência).
 *
 * Não consulta o Mercado Livre: a sincronização dos dados remotos é server-side (webhook + agendador
 * a cada ~5 min + reconciliação), e roda mesmo sem nenhum navegador aberto.
 */
export function useAutoListingSync(enabled: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    let mark: string | null = null;
    let cancelled = false;
    async function check() {
      if (document.visibilityState === "hidden") return;
      const r = await api<{ mark: string }>("/api/marketplace/listings/changes");
      if (cancelled || !r.ok) return;
      if (mark !== null && r.data.mark !== mark) router.refresh();
      mark = r.data.mark;
    }
    void check();
    const t = setInterval(check, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled, router]);
}
