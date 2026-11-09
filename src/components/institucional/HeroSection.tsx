import Image from "next/image";
import { company, hero } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { HeroSteps, TypingText } from "./HeroMotion";
import { Icon } from "./icons";
import { PortalLink } from "./PortalLink";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

const fx = (delay: number) => ({ "data-fx": "", style: { ["--d" as string]: `${delay}ms` } });

/**
 * Hero: composição animada de cards no topo (mensagem digitada, etapas sendo concluídas, cartão da
 * marca) e título grande embaixo, revelado palavra a palavra. Apenas fatos confirmados da Lopes.
 */
export function HeroSection() {
  return (
    <section id={SECTION_IDS.inicio} className={s.hero} aria-labelledby="hero-title">
      <div className={s.heroInner}>
        <div className={s.composition} aria-hidden="true">
          <div className={`${s.fx} ${s.promptCard}`} {...fx(0)}>
            <span className={`${s.mono} ${s.promptTag}`}>Lopes · desde {company.foundingYear}</span>
            <p>
              <TypingText text={hero.promptCard} />
            </p>
            <span className={s.promptSend}>
              <Icon name="arrowUpRight" size={14} />
            </span>
          </div>

          <div className={s.fx} {...fx(150)}>
            <HeroSteps steps={hero.steps} />
          </div>

          <div className={`${s.fx} ${s.brandCard}`} {...fx(300)}>
            {company.logoLight && (
              <Image src={company.logoLight.src} alt="" width={company.logoLight.width} height={company.logoLight.height} priority />
            )}
            <div>
              <p className={s.brandCardTitle}>
                {company.slogan.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </p>
              <p className={`${s.mono} ${s.brandCardMeta}`}>{company.descriptor}</p>
            </div>
          </div>
        </div>

        <div className={s.heroBottom}>
          <div>
            <span className={s.label}>{hero.label}</span>
            <h1 id="hero-title" className={s.heroTitle}>
              <RevealText text={hero.title} />
            </h1>
          </div>
          <div className={`${s.fx} ${s.heroSide}`} {...fx(400)}>
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
