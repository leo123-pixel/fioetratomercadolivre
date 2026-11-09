"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Número que conta até o valor final quando entra na tela. O HTML do servidor já traz o valor final
 * (leitores de tela e quem não tem JS veem o número correto).
 */
export function CountUp({ value, className }: { value: string; className?: string }) {
  const match = value.match(/^(\d+)(.*)$/);
  const target = match ? Number(match[1]) : null;
  const suffix = match ? match[2] : "";
  const start = target !== null && target > 1000 ? target - 40 : 0;
  const [display, setDisplay] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (target === null || !el || typeof IntersectionObserver === "undefined") return;
    setDisplay(`${start}${suffix}`);
    let raf = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const began = performance.now();
        const duration = 1400;
        const tick = (now: number) => {
          const t = Math.min(1, (now - began) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplay(`${Math.round(start + (target - start) * eased)}${suffix}`);
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [target, start, suffix]);

  return (
    <span ref={ref} className={className} aria-label={value}>
      <span aria-hidden="true">{display}</span>
    </span>
  );
}
