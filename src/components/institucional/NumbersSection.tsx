import { numbers } from "@/content/lopes";
import { CountUp } from "./CountUp";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

const fx = (delay: number) => ({ "data-fx": "", style: { ["--d" as string]: `${delay}ms` } });

/** Cards de números grandes (contam ao entrar na tela) — somente valores confirmados no catálogo. */
export function NumbersSection() {
  return (
    <section className={`${s.section} ${s.sectionTight}`} aria-labelledby="numeros-title">
      <div className={s.numbersHead}>
        <h2 id="numeros-title" className={s.h2} style={{ maxWidth: "18ch" }}>
          <RevealText text={numbers.title} />
        </h2>
      </div>
      <ul className={s.numbers}>
        {numbers.items.map((item, index) => (
          <li key={item.label} className={`${s.fx} ${s.numberCard}`} {...fx(index * 120)}>
            <p>{item.text}</p>
            <div>
              <CountUp value={item.value} className={s.numberValue} />
              <span className={s.numberLabel}>{item.label}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
