import { identity } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

/** Bloco escuro: propósito, missão, visão e valores (catálogo oficial). */
export function IdentitySection() {
  return (
    <section id={SECTION_IDS.quemSomos} className={s.dark} aria-labelledby="quem-somos-title">
      <div className={s.split}>
        <div>
          <span className={s.labelLight}>{identity.label}</span>
          <h2 id="quem-somos-title" className={s.h2}>
            <RevealText text={identity.titleMuted} className={s.mutedLight} />{" "}
            <RevealText text={identity.title} offset={3} />
          </h2>
        </div>
        <div className={s.darkText}>
          <p>{identity.text}</p>
        </div>
      </div>

      <div className={s.statements}>
        {identity.statements.map((item) => (
          <div key={item.label} className={s.statement}>
            <h3 className={s.mono}>{item.label}</h3>
            <p>{item.text}</p>
          </div>
        ))}
      </div>

      <div className={s.valuesWrap}>
        <span className={s.labelLight}>{identity.valuesTitle}</span>
        <ul className={s.values}>
          {identity.values.map((value) => (
            <li key={value.title}>
              <h4>{value.title}</h4>
              <p>{value.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
