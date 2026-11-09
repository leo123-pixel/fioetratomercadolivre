"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ADMIN_LOGIN_HREF, NAV_LINKS } from "@/lib/site/links";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

export function InstitutionalHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Menu móvel: Esc fecha, foco preso no painel, rolagem da página travada enquanto aberto.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.querySelector<HTMLElement>("a, button")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      const candidates = [buttonRef.current, ...items].filter(Boolean) as HTMLElement[];
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onResize = () => {
      if (window.matchMedia("(min-width: 1081px)").matches) close();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  // O painel móvel fica fora do <header>: o backdrop-filter do cabeçalho criaria um contêiner para
  // elementos position: fixed e o painel não ocuparia a tela inteira.
  return (
    <>
    <header className={`${s.header} ${scrolled || open ? s.headerScrolled : ""}`}>
      <div className={s.headerInner}>
        <Logo />

        <nav className={s.nav} aria-label="Navegação principal">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className={s.navLink}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className={s.headerActions}>
          <a href={ADMIN_LOGIN_HREF} className={s.adminLink} rel="nofollow">
            <Icon name="lock" size={14} />
            Área administrativa
          </a>
          <PortalLink className={`${s.btnPrimary} ${s.btnSmall}`} label="Portal de Pedidos" />
        </div>

        <button
          ref={buttonRef}
          type="button"
          className={s.menuButton}
          aria-expanded={open}
          aria-controls="menu-mobile"
          aria-label={open ? "Fechar menu" : "Abrir menu"}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "close" : "menu"} size={22} />
        </button>
      </div>
    </header>

      <div
        id="menu-mobile"
        ref={panelRef}
        className={`${s.mobilePanel} ${open ? s.mobilePanelOpen : ""}`}
        aria-hidden={!open}
        inert={!open}
      >
        <nav aria-label="Navegação principal (móvel)">
          <ul className={s.mobileNav}>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} onClick={() => close()}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={s.mobileActions}>
          <PortalLink className={s.btnPrimary} label="Portal de Pedidos" onNavigate={() => close()} />
          <a href={ADMIN_LOGIN_HREF} className={s.adminLink} rel="nofollow">
            <Icon name="lock" size={14} />
            Área administrativa
          </a>
        </div>
      </div>
    </>
  );
}
