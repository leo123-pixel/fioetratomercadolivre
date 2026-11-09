import { company, contact, footer } from "@/content/lopes";
import { ADMIN_LOGIN_HREF, NAV_LINKS, PRIVACY_PATH, portalHref, telHref, whatsappHref } from "@/lib/site/links";
import { socialLinks } from "./ContactSection";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import s from "./site.module.css";

export function InstitutionalFooter() {
  const year = new Date().getFullYear();
  const portal = portalHref();
  const whatsapp = whatsappHref(contact.whatsapp, contact.whatsappMessage);
  const phone = telHref(contact.phone);
  const socials = socialLinks();

  return (
    <footer className={s.footer}>
      <div className={s.footerGrid}>
        <div className={s.footerBrand}>
          <Logo light />
          <p className={s.footerSlogan}>
            {company.slogan.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
          <p className={s.footerAbout}>{footer.description}</p>
        </div>

        <nav aria-label="Navegação do rodapé">
          <h2 className={s.footerTitle}>Navegação</h2>
          <ul className={s.footerList}>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <h2 className={s.footerTitle}>Acessos</h2>
          <ul className={s.footerList}>
            <li>
              <a href={portal.href} rel={portal.external ? "noopener" : undefined}>
                Portal de pedidos
                {portal.external && <Icon name="arrowUpRight" size={14} />}
              </a>
            </li>
            <li>
              <a href={ADMIN_LOGIN_HREF} rel="nofollow">
                <Icon name="lock" size={14} />
                Área administrativa
              </a>
            </li>
            <li>
              <a href={PRIVACY_PATH}>Política de Privacidade</a>
            </li>
          </ul>
        </div>

        <div>
          <h2 className={s.footerTitle}>Contato</h2>
          <ul className={s.footerList}>
            <li>
              {company.city} — {company.stateCode}
            </li>
            {whatsapp && (
              <li>
                <a href={whatsapp} rel="noopener">
                  WhatsApp {contact.whatsapp}
                </a>
              </li>
            )}
            {phone && (
              <li>
                <a href={phone}>{contact.phone}</a>
              </li>
            )}
            {contact.email && (
              <li>
                <a href={`mailto:${contact.email}`}>{contact.email}</a>
              </li>
            )}
            {socials.map((social) => (
              <li key={social.key}>
                <a href={social.href} rel="noopener" target="_blank">
                  <Icon name={social.key} size={14} />
                  {social.label}
                  <span className={s.srOnly}> (abre em nova aba)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={s.footerBottom}>
        <p>
          © {year} {company.legalName ?? company.name}. Todos os direitos reservados.
          {company.cnpj && <> CNPJ {company.cnpj}.</>}
        </p>
        <p>Vendas destinadas a clientes com CNPJ.</p>
      </div>
    </footer>
  );
}
