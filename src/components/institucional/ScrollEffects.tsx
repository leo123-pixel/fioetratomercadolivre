"use client";

import { useEffect } from "react";

/**
 * Animações de entrada ao rolar: todo elemento com `data-fx` começa "armado" (escondido pelo CSS)
 * e recebe `data-fx="in"` quando entra na tela. Sem JS, nada é escondido.
 * São animações suaves (opacidade e pequeno deslocamento), mantidas mesmo com "reduzir movimento".
 */
export function ScrollEffects() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-fx]"));
    if (typeof IntersectionObserver === "undefined") {
      elements.forEach((el) => el.setAttribute("data-fx", "in"));
      return;
    }
    elements.forEach((el) => el.setAttribute("data-fx", "armed"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-fx", "in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    // Um frame de atraso para o estado "armado" ser pintado antes da transição.
    const frame = requestAnimationFrame(() => elements.forEach((el) => observer.observe(el)));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return null;
}
