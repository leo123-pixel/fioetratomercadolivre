import Image from "next/image";
import { about } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import s from "./site.module.css";

export function AboutSection() {
  return (
    <section id={SECTION_IDS.sobre} className={s.section} aria-labelledby="sobre-title">
      <div className={s.aboutGrid}>
        <div>
          <p className={s.eyebrow}>{about.eyebrow}</p>
          <h2 id="sobre-title" className={s.h2}>
            {about.title}
          </h2>
          <div className={s.prose}>
            {about.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 32)}>{paragraph}</p>
            ))}
          </div>
          <p className={s.commitment}>{about.commitment}</p>
        </div>

        <div>
          {about.image && (
            <div className={s.aboutImage}>
              <Image src={about.image.src} alt={about.image.alt} fill loading="lazy" sizes="(max-width: 960px) 100vw, 45vw" />
            </div>
          )}
          <div className={s.chainCard}>
            <h3 className={s.chainTitle}>{about.chainTitle}</h3>
            <ol className={s.chain}>
              {about.chain.map((step, index) => (
                <li key={step.label} className={`${s.chainItem} ${index === 1 ? s.chainItemHighlight : ""}`}>
                  <span className={s.chainDot} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong className={s.chainLabel}>{step.label}</strong>
                    <span className={s.chainText}>{step.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
