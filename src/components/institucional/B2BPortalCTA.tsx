import { portalCta } from "@/content/lopes";
import { b2bPortalUrl, SECTION_IDS } from "@/lib/site/links";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

export function B2BPortalCTA() {
  const configured = b2bPortalUrl() !== null;
  if (!configured && process.env.NODE_ENV === "production") {
    // Pendência visível no log de build/servidor; o botão leva ao contato até a URL ser definida.
    console.warn("[site] NEXT_PUBLIC_B2B_PORTAL_URL não configurada: botões do portal B2B apontam para #contato.");
  }

  return (
    <section id={SECTION_IDS.portal} className={s.cta} aria-labelledby="portal-title">
      <div className={s.ctaInner}>
        <p className={s.eyebrowLight}>{portalCta.eyebrow}</p>
        <h2 id="portal-title" className={s.ctaTitle}>
          {portalCta.title}
        </h2>
        <p className={s.ctaText}>{portalCta.text}</p>
        <div className={s.ctaActions}>
          <PortalLink className={`${s.btnGold} ${s.btnCaps}`} label={portalCta.button} />
        </div>
        <p className={s.ctaNote}>{portalCta.note}</p>
        {!configured && process.env.NODE_ENV !== "production" && (
          <p className={s.devNotice} role="note">
            Pendência (visível só em desenvolvimento): defina <code>NEXT_PUBLIC_B2B_PORTAL_URL</code> com o endereço
            do portal B2B existente. Enquanto isso, os botões do portal levam à seção de contato.
          </p>
        )}
      </div>
    </section>
  );
}
