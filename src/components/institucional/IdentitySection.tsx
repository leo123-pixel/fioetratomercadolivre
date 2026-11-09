import { identity } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { Emphasis } from "./Emphasis";
import s from "./site.module.css";

/** Quem somos: propósito, missão, visão e valores (catálogo oficial). */
export function IdentitySection() {
  return (
    <section id={SECTION_IDS.quemSomos} className={s.sectionDark} aria-labelledby="quem-somos-title">
      <div className={s.container}>
        <h2 id="quem-somos-title" className={s.eyebrowLight}>
          {identity.eyebrow}
        </h2>
        <dl className={s.statements}>
          {identity.statements.map((item) => (
            <div key={item.label} className={s.statement}>
              <dt>{item.label}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>

        <h3 className={s.valuesTitle}>{identity.valuesTitle}</h3>
        <ul className={s.values}>
          {identity.values.map((value) => (
            <li key={value.title}>
              <h4 className={s.valueTitle}>{value.title}</h4>
              <p className={s.valueText}>{value.text}</p>
            </li>
          ))}
        </ul>

        <p className={s.closing}>
          <Emphasis text={identity.closing} emphasis={identity.closingEmphasis} className={s.highlightLight} />
        </p>
      </div>
    </section>
  );
}
