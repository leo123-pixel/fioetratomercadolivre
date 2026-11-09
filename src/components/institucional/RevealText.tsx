"use client";

import { useEffect, useRef } from "react";
import s from "./site.module.css";

/**
 * Texto cujas palavras "acendem" ao entrar na tela. Sem JS ou com prefers-reduced-motion,
 * o texto aparece normalmente (o estado apagado só é aplicado depois que o observador é armado).
 */
export function RevealText({ text, offset = 0, className }: { text: string; offset?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.9) return; // já visível no carregamento: não anima
    el.dataset.reveal = "armed";
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          el.dataset.reveal = "visible";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const words = text.split(" ");
  return (
    <span ref={ref} className={className}>
      {words.map((word, index) => (
        <span key={`${word}-${index}`} className={s.revealWord} style={{ ["--i" as string]: index + offset }}>
          {word}
          {index < words.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}
