import { company, contact, footer } from "@/content/lopes";
import { ADMIN_LOGIN_HREF, NAV_LINKS, PRIVACY_PATH, portalHref, telHref, whatsappHref } from "@/lib/site/links";
import { socialLinks } from "./ContactSection";
import { Icon } from "./icons";
import s from "./site.module.css";

export function InstitutionalFooter() {
  const year = new Date().getFullYear();
  const portal = portalHref();
  const whatsapp = whatsappHref(contact.whatsapp, contact.whatsappMessage);
  const phone = telHref(contact.phone);
  const socials = socialLinks();
  const name = company.shortName.toLowerCase();

  return (
    <footer className={s.footer}>
      {/* Nome da empresa em tipografia grande (não é o logotipo). */}
      <p className={s.wordmark} aria-hidden="true">
        {name.slice(0, -1)}
        <span>{name.slice(-1)}</span>
      </p>

      <div className={s.footerGrid}>
        <div>
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
                <Icon name="lock" size={13} />
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
            {phone && (
              <li>
                <a href={phone}>{contact.phone}</a>
              </li>
            )}
            {whatsapp && (
              <li>
                <a href={whatsapp} rel="noopener">
                  WhatsApp {contact.whatsapp}
                </a>
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
                  {social.label}
                  <span className={s.srOnly}> (abre em nova aba)</span>
                </a>
              </li>
            ))}
            <li>
              {company.city} — {company.stateCode}
            </li>
          </ul>
        </div>
      </div>

      <div className={s.footerBottom}>
        <p className={s.mono}>
          © {year} {company.legalName ?? company.name}. Todos os direitos reservados.
          {company.cnpj && <> CNPJ {company.cnpj}.</>}
        </p>
        <p className={s.mono}>Vendas destinadas a clientes com CNPJ</p>
      </div>
    </footer>
  );
}
