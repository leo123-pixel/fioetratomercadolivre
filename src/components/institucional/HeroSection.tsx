import Image from "next/image";
import { company, hero } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

/** Destaca (itálico) a primeira ocorrência de `emphasis` dentro do título. */
function EmphasizedTitle({ text, emphasis }: { text: string; emphasis?: string }) {
  const index = emphasis ? text.indexOf(emphasis) : -1;
  if (!emphasis || index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <em>{emphasis}</em>
      {text.slice(index + emphasis.length)}
    </>
  );
}

export function HeroSection() {
  return (
    <section id={SECTION_IDS.inicio} className={s.hero} aria-labelledby="hero-title">
      <div className={s.heroGrid}>
        <div className={s.reveal}>
          <p className={s.eyebrow}>{hero.eyebrow}</p>
          <h1 id="hero-title" className={s.heroTitle}>
            <EmphasizedTitle text={hero.title} emphasis={hero.titleEmphasis} />
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
              <Image
                src={hero.image.src}
                alt={hero.image.alt}
                fill
                priority
                sizes="(max-width: 960px) 100vw, 40vw"
              />
            </div>
          ) : (
            <aside className={s.heroCard} aria-label={`${company.name} em números`}>
              <span className={s.yearsNumber} aria-hidden="true">
                {company.yearsLabel}
              </span>
              <span className={s.yearsLabel}>
                <span className={s.srOnly}>Mais de 40 </span>anos no mercado da beleza
              </span>
              <p className={s.heroCardText}>{hero.cardText}</p>
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
