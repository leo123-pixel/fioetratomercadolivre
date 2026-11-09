import Image from "next/image";
import { company, hero } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { Icon } from "./icons";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

/**
 * Hero: composição de cards no topo (mensagem, etapas, cartão da marca) e título grande embaixo.
 * Toda a composição usa apenas fatos confirmados da Lopes.
 */
export function HeroSection() {
  return (
    <section id={SECTION_IDS.inicio} className={s.hero} aria-labelledby="hero-title">
      <span className={s.heroLine} aria-hidden="true" />
      <div className={s.heroInner}>
        <div className={s.composition} aria-hidden="true">
          <div className={s.promptCard}>
            <span className={`${s.mono} ${s.promptTag}`}>Lopes · desde {company.foundingYear}</span>
            <p>{hero.promptCard}</p>
            <span className={s.promptSend}>
              <Icon name="arrowUpRight" size={14} />
            </span>
          </div>

          <ul className={s.steps}>
            {hero.steps.map((step) => (
              <li key={step} className={s.step}>
                <span className={s.stepCheck}>
                  <Icon name="check" size={10} strokeWidth={3} />
                </span>
                {step}
              </li>
            ))}
          </ul>

          <div className={s.brandCard}>
            {company.logoLight && (
              <Image src={company.logoLight.src} alt="" width={company.logoLight.width} height={company.logoLight.height} priority />
            )}
            <div>
              <p className={s.brandCardTitle}>
                {company.slogan.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </p>
              <p className={`${s.mono} ${s.brandCardMeta}`}>
                {company.city} · {company.stateCode} · {company.descriptor}
              </p>
            </div>
          </div>
        </div>

        <div className={s.heroBottom}>
          <div>
            <span className={s.label}>{hero.label}</span>
            <h1 id="hero-title" className={s.heroTitle}>
              {hero.title}
            </h1>
          </div>
          <div className={s.heroSide}>
            <p className={s.lead}>{hero.subtitle}</p>
            <div className={s.heroActions}>
              <PortalLink className={s.btnPrimary} label={hero.primaryCta} />
              <a href={`#${SECTION_IDS.sobre}`} className={s.btnGhost}>
                {hero.secondaryCta}
              </a>
            </div>
            <p className={`${s.mono} ${s.heroNote}`}>{hero.b2bNote}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
