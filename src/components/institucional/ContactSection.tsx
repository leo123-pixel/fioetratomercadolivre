import { contact, contactSection } from "@/content/lopes";
import { portalHref, SECTION_IDS, telHref, whatsappHref } from "@/lib/site/links";
import { Icon } from "./icons";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

const fx = (delay: number) => ({ "data-fx": "", style: { ["--d" as string]: `${delay}ms` } });

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

interface Channel {
  key: string;
  icon: string;
  label: string;
  value: string;
  href: string;
  newTab?: boolean;
}

/** Contato: título à esquerda e canais em lista, cada um com ícone. Só canais confirmados. */
export function ContactSection() {
  const whatsapp = whatsappHref(contact.whatsapp, contact.whatsappMessage);
  const phone = telHref(contact.phone);
  const portal = portalHref();

  const channels: Channel[] = [];
  if (whatsapp && contact.whatsapp)
    channels.push({ key: "whatsapp", icon: "whatsapp", label: "WhatsApp", value: contact.whatsapp, href: whatsapp, newTab: true });
  if (phone && contact.phone) channels.push({ key: "phone", icon: "phone", label: "Telefone", value: contact.phone, href: phone });
  if (contact.email) channels.push({ key: "email", icon: "mail", label: "E-mail", value: contact.email, href: `mailto:${contact.email}` });
  for (const social of socialLinks())
    channels.push({ key: social.key, icon: social.key, label: social.label, value: handleFromUrl(social.href), href: social.href, newTab: true });
  channels.push({ key: "portal", icon: "orders", label: "Portal de pedidos", value: "Clientes com CNPJ", href: portal.href });

  return (
    <section id={SECTION_IDS.contato} className={s.section} aria-labelledby="contato-title">
      <div className={s.contactLayout}>
        <div>
          <span className={s.label}>{contactSection.label}</span>
          <h2 id="contato-title" className={s.h2}>
            <RevealText text={contactSection.title} />
          </h2>
          <p className={`${s.lead} ${s.fx}`} style={{ marginTop: 20, ["--d" as string]: "150ms" }} data-fx="">
            {contactSection.intro}
          </p>
          {contact.hours && <p className={s.contactHours}>{contact.hours}</p>}
        </div>

        <ul className={s.channels}>
          {channels.map((channel, index) => (
            <li key={channel.key} className={s.fx} {...fx(index * 110)}>
              <a
                href={channel.href}
                className={s.channel}
                {...(channel.newTab ? { target: "_blank", rel: "noopener" } : channel.key === "portal" ? { rel: "noopener" } : {})}
              >
                <span className={s.channelIcon} aria-hidden="true">
                  <Icon name={channel.icon} size={22} />
                </span>
                <span className={s.channelText}>
                  <span className={s.mono}>{channel.label}</span>
                  <span className={s.channelValue}>{channel.value}</span>
                </span>
                <span className={s.channelArrow} aria-hidden="true">
                  <Icon name="arrowUpRight" size={20} />
                </span>
                {channel.newTab && <span className={s.srOnly}> (abre em nova aba)</span>}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
