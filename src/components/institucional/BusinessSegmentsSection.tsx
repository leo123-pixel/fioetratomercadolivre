import { segments } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { Icon } from "./icons";
import s from "./site.module.css";

export function BusinessSegmentsSection() {
  return (
    <section id={SECTION_IDS.lojistas} className={s.sectionSand} aria-labelledby="lojistas-title">
      <div className={s.container}>
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>{segments.eyebrow}</p>
          <h2 id="lojistas-title" className={s.h2}>
            {segments.title}
          </h2>
          <p className={s.lead}>{segments.intro}</p>
        </div>
        <div className={s.segmentsLayout}>
          <ul className={s.cardGrid}>
            {segments.items.map((item) => (
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
          <div className={s.b2bBox}>
            <span className={s.cardIcon}>
              <Icon name="professional" />
            </span>
            <div>
              <h3 className={s.b2bTitle}>{segments.b2bTitle}</h3>
              <p className={s.b2bText}>{segments.b2bText}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
