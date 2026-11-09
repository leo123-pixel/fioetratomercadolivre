import { portalCta } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { PortalLink } from "./PortalLink";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

/** Chamada final para o portal B2B, emendada ao rodapé (mesmo fundo verde-petróleo). */
export function B2BPortalCTA() {
  return (
    <section id={SECTION_IDS.portal} className={s.closing} aria-labelledby="portal-title">
      <div className={s.closingInner}>
        <h2 id="portal-title" className={s.h2}>
          <RevealText text={portalCta.title} />
        </h2>
        <div className={s.fx} data-fx="" style={{ ["--d" as string]: "200ms" }}>
          <p className={s.lead} style={{ marginTop: 20, color: "rgb(240 238 230 / 0.75)" }}>
            {portalCta.text}
          </p>
          <div className={s.closingActions}>
            <PortalLink className={s.btnLight} label={portalCta.button} />
            <a href={`#${SECTION_IDS.contato}`} className={s.btnGhostLight}>
              {portalCta.secondary}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
