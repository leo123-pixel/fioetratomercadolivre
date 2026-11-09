import type { Metadata } from "next";
import { getServerAdminSession } from "@/lib/auth/server-session";
import { LogoutButton } from "./LogoutButton";
import "./globals.css";

/** Área administrativa do integrador. As páginas continuam protegidas individualmente (requireAdminPage). */
export const metadata: Metadata = {
  title: "Fio & Trato · Integrador ADS ↔ Mercado Livre",
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
        <span className="brand">Fio &amp; Trato</span>
        <span className="brand-sub">Integrador ADS ↔ Mercado Livre</span>
        {loggedIn && (
          <nav className="nav" aria-label="Principal">
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
