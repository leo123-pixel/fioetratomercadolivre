import type { Metadata } from "next";
import { getServerAdminSession } from "@/lib/auth/server-session";
import { LogoutButton } from "./LogoutButton";
import "./globals.css";

/** Área administrativa do integrador. As páginas continuam protegidas individualmente (requireAdminPage). */
export const metadata: Metadata = {
  title: "Área Administrativa – Lopes Cosméticos",
  robots: { index: false, follow: false, nocache: true },
};

async function hasSession(): Promise<boolean> {
  try {
    return (await getServerAdminSession()) !== null;
  } catch {
    // Configuração incompleta: as páginas já exibem o aviso; aqui só não mostramos "Sair".
    return false;
  }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const loggedIn = await hasSession();
  return (
    <>
      <header className="topbar">
        <a className="brand-link" href={loggedIn ? "/painel" : "/login"}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/brand/lopes-logo-light.png" alt="" width={44} height={33} />
          <span className="brand-text">
            <span className="brand">Área Administrativa – Lopes Cosméticos</span>
            <span className="brand-sub">Acesso somente para pessoas autorizadas</span>
          </span>
        </a>
        {loggedIn && (
          <nav className="nav" aria-label="Principal">
            <a href="/painel">Painel</a>
            <a href="/produtos">Produtos</a>
            <a href="/anuncios">Anúncios</a>
            <a href="/pedidos">Pedidos</a>
            <a href="/importacoes">Importações</a>
            <a href="/configuracoes/tabelas-de-preco">Tabelas de preço</a>
            <a href="/configuracoes/integracoes/mercadolivre">Mercado Livre</a>
            <a href="/configuracoes/integracoes/mercadolivre/monitoramento">Monitoramento</a>
            <LogoutButton />
          </nav>
        )}
      </header>
      <main className="container">{children}</main>
    </>
  );
}
