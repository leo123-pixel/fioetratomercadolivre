import { company, contact, contactSection } from "@/content/lopes";
import { b2bPortalUrl, SECTION_IDS, telHref, whatsappHref } from "@/lib/site/links";
import { Icon } from "./icons";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

const SOCIAL_LABELS = { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn" } as const;

/** Redes sociais confirmadas (somente as preenchidas em src/content/lopes.ts). */
export function socialLinks() {
  const keys = Object.keys(SOCIAL_LABELS) as Array<keyof typeof SOCIAL_LABELS>;
  return keys.flatMap((key) => {
    const href = contact.social[key];
    return href ? [{ key, label: SOCIAL_LABELS[key] as string, href }] : [];
  });
}

export function ContactSection() {
  const whatsapp = whatsappHref(contact.whatsapp, contact.whatsappMessage);
  const phone = telHref(contact.phone);
  const socials = socialLinks();
  const hasChannels = Boolean(phone || contact.email || contact.hours || whatsapp);

  return (
    <section id={SECTION_IDS.contato} className={s.sectionBeige} aria-labelledby="contato-title">
      <div className={s.container}>
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>{contactSection.eyebrow}</p>
          <h2 id="contato-title" className={s.h2}>
            {contactSection.title}
          </h2>
          <p className={s.lead}>{contactSection.intro}</p>
        </div>

        <div className={s.contactGrid}>
          <address className={s.contactCard} style={{ fontStyle: "normal" }}>
            <h3 className={s.contactCardTitle}>
              <Icon name="pin" size={18} />
              Localização
            </h3>
            <p className={s.contactValue}>
              {company.city} — {company.stateCode}
            </p>
            <p className={s.contactDetail}>{contact.address ?? company.state}</p>
          </address>

          {hasChannels && (
            <div className={s.contactCard}>
              <h3 className={s.contactCardTitle}>
                <Icon name="phone" size={18} />
                Atendimento comercial
              </h3>
              <ul className={s.contactList}>
                {whatsapp && contact.whatsapp && (
                  <li>
                    <a href={whatsapp} rel="noopener">
                      <Icon name="whatsapp" size={18} />
                      WhatsApp {contact.whatsapp}
                    </a>
                  </li>
                )}
                {phone && (
                  <li>
                    <a href={phone}>
                      <Icon name="phone" size={18} />
                      {contact.phone}
                    </a>
                  </li>
                )}
                {contact.email && (
                  <li>
                    <a href={`mailto:${contact.email}`}>
                      <Icon name="mail" size={18} />
                      {contact.email}
                    </a>
                  </li>
                )}
                {contact.hours && (
                  <li className={s.contactDetail} style={{ display: "flex", gap: 10, margin: 0 }}>
                    <Icon name="clock" size={18} />
                    {contact.hours}
                  </li>
                )}
              </ul>
            </div>
          )}

          {socials.length > 0 && (
            <div className={s.contactCard}>
              <h3 className={s.contactCardTitle}>
                <Icon name="instagram" size={18} />
                Redes sociais
              </h3>
              <ul className={s.contactList}>
                {socials.map((social) => (
                  <li key={social.key}>
                    <a href={social.href} rel="noopener" target="_blank">
                      <Icon name={social.key} size={18} />
                      {social.label}
                      <span className={s.srOnly}> (abre em nova aba)</span>
                    </a>
                  </li>
                ))}
              </ul>
              <p className={s.contactDetail}>Acompanhe novidades do portfólio e lançamentos das marcas.</p>
            </div>
          )}
        </div>

        <div className={s.contactActions}>
          {whatsapp && (
            <a href={whatsapp} className={s.btnPrimary} rel="noopener">
              <Icon name="whatsapp" size={18} />
              Falar pelo WhatsApp
            </a>
          )}
          {/* Sem URL do portal, o link apontaria para esta própria seção: só exibe quando configurado. */}
          {b2bPortalUrl() && <PortalLink className={s.btnOutline} label="Acessar portal de pedidos" />}
        </div>
      </div>
    </section>
  );
}
