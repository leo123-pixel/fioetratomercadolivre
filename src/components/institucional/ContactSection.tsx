import { company, contact, contactSection } from "@/content/lopes";
import { portalHref, SECTION_IDS, telHref, whatsappHref } from "@/lib/site/links";
import { Icon } from "./icons";
import { RevealText } from "./RevealText";
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

function handleFromUrl(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "").split("/").pop();
  return path ? `@${path}` : url;
}

interface ContactItem {
  key: string;
  label: string;
  icon: string;
  value: string;
  detail?: string;
  href?: string;
  external?: boolean;
}

export function ContactSection() {
  const whatsapp = whatsappHref(contact.whatsapp, contact.whatsappMessage);
  const phone = telHref(contact.phone);
  const portal = portalHref();

  const items: ContactItem[] = [];
  if (whatsapp && contact.whatsapp)
    items.push({ key: "whatsapp", label: "WhatsApp", icon: "whatsapp", value: contact.whatsapp, href: whatsapp, external: true });
  if (phone && contact.phone)
    items.push({ key: "phone", label: "Telefone", icon: "phone", value: contact.phone, detail: contact.hours ?? undefined, href: phone });
  if (contact.email) items.push({ key: "email", label: "E-mail", icon: "mail", value: contact.email, href: `mailto:${contact.email}` });
  for (const social of socialLinks())
    items.push({ key: social.key, label: social.label, icon: social.key, value: handleFromUrl(social.href), href: social.href, external: true });
  items.push({
    key: "portal",
    label: "Portal de pedidos",
    icon: "orders",
    value: "Acessar o portal",
    detail: "Exclusivo para clientes com CNPJ",
    href: portal.href,
    external: portal.external,
  });
  items.push({
    key: "location",
    label: "Localização",
    icon: "pin",
    value: `${company.city} — ${company.stateCode}`,
    detail: contact.address ?? company.state,
  });

  return (
    <section id={SECTION_IDS.contato} className={s.section} aria-labelledby="contato-title">
      <div className={s.container}>
        <span className={s.label}>{contactSection.label}</span>
        <h2 id="contato-title" className={s.h2}>
          <RevealText text={contactSection.title} />
        </h2>
        <p className={s.lead} style={{ marginTop: 18 }}>
          {contactSection.intro}
        </p>
      </div>
      <div className={s.contactGrid}>
        {items.map((item) => {
          const body = (
            <>
              <span className={s.contactCardTop}>
                <span className={s.mono}>{item.label}</span>
                <Icon name={item.href ? "arrowUpRight" : item.icon} size={18} />
              </span>
              <span>
                <span className={s.contactValue} style={{ display: "block" }}>
                  {item.value}
                </span>
                {item.detail && (
                  <span className={s.contactDetail} style={{ display: "block" }}>
                    {item.detail}
                  </span>
                )}
              </span>
            </>
          );
          return item.href ? (
            <a
              key={item.key}
              href={item.href}
              className={s.contactCard}
              {...(item.external ? { rel: "noopener", target: item.key === "portal" ? undefined : "_blank" } : {})}
            >
              {body}
              {item.external && item.key !== "portal" && <span className={s.srOnly}> (abre em nova aba)</span>}
            </a>
          ) : (
            <address key={item.key} className={s.contactCard} style={{ fontStyle: "normal" }}>
              {body}
            </address>
          );
        })}
      </div>
    </section>
  );
}
