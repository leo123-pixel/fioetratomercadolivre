import { numbers } from "@/content/lopes";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

/** Cards de números grandes — somente valores confirmados no catálogo oficial. */
export function NumbersSection() {
  return (
    <section className={s.section} aria-labelledby="numeros-title" style={{ paddingTop: 0 }}>
      <div className={s.numbersHead}>
        <h2 id="numeros-title" className={s.h2} style={{ maxWidth: "18ch" }}>
          <RevealText text={numbers.title} />
        </h2>
      </div>
      <ul className={s.numbers}>
        {numbers.items.map((item) => (
          <li key={item.label} className={s.numberCard}>
            <p>{item.text}</p>
            <div>
              <span className={s.numberValue}>{item.value}</span>
              <span className={s.numberLabel}>{item.label}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
