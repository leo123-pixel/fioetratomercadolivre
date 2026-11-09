"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import s from "./site.module.css";

/** Texto que é "digitado" ao carregar (o texto completo já vem do servidor). */
export function TypingText({ text }: { text: string }) {
  const [count, setCount] = useState(text.length);
  useEffect(() => {
    setCount(0);
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) window.clearInterval(timer);
    }, 32);
    return () => window.clearInterval(timer);
  }, [text]);
  return (
    <>
      {text.slice(0, count)}
      {count < text.length && <span className={s.caret} />}
    </>
  );
}

/** Etapas que vão sendo concluídas em sequência (carregando → concluído), em ciclo. */
export function HeroSteps({ steps }: { steps: readonly string[] }) {
  const [active, setActive] = useState(steps.length);
  useEffect(() => {
    setActive(0);
    let current = 0;
    let timer = 0;
    const advance = () => {
      current += 1;
      setActive(current);
      timer = current >= steps.length ? window.setTimeout(restart, 2600) : window.setTimeout(advance, 900);
    };
    const restart = () => {
      current = 0;
      setActive(0);
      timer = window.setTimeout(advance, 900);
    };
    timer = window.setTimeout(advance, 1200);
    return () => window.clearTimeout(timer);
  }, [steps.length]);

  return (
    <ul className={s.steps}>
      {steps.map((step, index) => {
        const state = index < active ? "done" : index === active ? "loading" : "idle";
        return (
          <li key={step} className={s.step} data-state={state}>
            <span className={s.stepCheck}>
              {state === "done" ? <Icon name="check" size={10} strokeWidth={3} /> : <span className={s.spinner} />}
            </span>
            {step}
          </li>
        );
      })}
    </ul>
  );
}
