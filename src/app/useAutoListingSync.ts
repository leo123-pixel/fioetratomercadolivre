"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/client-api";

const KEY = "fioetrato:listing-sync-at";
const INTERVAL_MS = 5 * 60_000;

/**
 * Ao abrir uma tela com anúncios publicados, relê no Mercado Livre o status de todos eles
 * (somente leitura), no máximo a cada 5 minutos por navegador. Se algum status mudou, recarrega
 * os dados da página. Complementa as notificações do ML, que dependem de configuração no DevCenter.
 */
export function useAutoListingSync(enabled: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
    } catch {
      // sessionStorage indisponível: segue sem memória entre telas
    }
    if (Date.now() - last < INTERVAL_MS) return;
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      // ignora
    }
    let cancelled = false;
    void api<{ checked: number; changed: number }>("/api/marketplace/listings/sync", { body: {} }).then((r) => {
      if (!cancelled && r.ok && r.data.changed > 0) router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, router]);
}
