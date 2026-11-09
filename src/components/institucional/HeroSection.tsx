import Image from "next/image";
import { company, hero } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { Emphasis } from "./Emphasis";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

export function HeroSection() {
  return (
    <section id={SECTION_IDS.inicio} className={s.hero} aria-labelledby="hero-title">
      <div className={s.heroGrid}>
        <div className={s.reveal}>
          <p className={s.eyebrow}>{hero.eyebrow}</p>
          <h1 id="hero-title" className={s.heroTitle}>
            <Emphasis text={hero.title} emphasis={hero.titleEmphasis} />
          </h1>
          <p className={s.heroSubtitle}>{hero.subtitle}</p>
          <div className={s.heroActions}>
            <PortalLink className={s.btnPrimary} label={hero.primaryCta} icon="arrowRight" />
            <a href={`#${SECTION_IDS.sobre}`} className={s.btnOutline}>
              {hero.secondaryCta}
            </a>
          </div>
          <p className={s.heroNote}>{hero.b2bNote}</p>
        </div>

        <div className={s.revealDelay}>
          {hero.image ? (
            <div className={s.heroImage}>
              <Image src={hero.image.src} alt={hero.image.alt} fill priority sizes="(max-width: 960px) 100vw, 40vw" />
            </div>
          ) : (
            <aside className={s.heroCard} aria-label={`${company.name} desde ${company.foundingYear}`}>
              <span className={s.yearsLabel}>{hero.cardLabel}</span>
              <span className={s.yearsNumber}>{company.foundingYear}</span>
              <span className={s.cardRule} aria-hidden="true" />
              <p className={s.heroCardText}>
                {company.slogan.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </p>
              <ul className={s.heroList}>
                {hero.highlights.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </div>
    </section>
  );
}
