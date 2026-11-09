"use client";

import { useEffect, useRef } from "react";
import s from "./site.module.css";

/**
 * Texto cujas palavras "acendem" em sequência ao entrar na tela (como na referência).
 * Sem JS o texto aparece normalmente: o estado apagado só é aplicado depois que o observador é armado.
 * É uma animação só de opacidade, mantida mesmo com "reduzir movimento".
 */
export function RevealText({ text, offset = 0, className }: { text: string; offset?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    el.dataset.reveal = "armed";
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          el.dataset.reveal = "visible";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    const frame = requestAnimationFrame(() => observer.observe(el));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
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
