import { differentials } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { Icon } from "./icons";
import s from "./site.module.css";

export function DifferentialsSection() {
  return (
    <section id={SECTION_IDS.diferenciais} className={s.section} aria-labelledby="diferenciais-title">
      <div className={s.container}>
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>{differentials.eyebrow}</p>
          <h2 id="diferenciais-title" className={s.h2}>
            {differentials.title}
          </h2>
        </div>
        <ul className={s.cardGrid}>
          {differentials.items.map((item) => (
            <li key={item.title}>
              <article className={s.card}>
                <span className={s.cardIcon}>
                  <Icon name={item.icon} />
                </span>
                <h3 className={s.cardTitle}>{item.title}</h3>
                <p className={s.cardText}>{item.text}</p>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
