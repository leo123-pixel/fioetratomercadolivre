import type { Metadata } from "next";
import "./globals.css";

/** Área administrativa do integrador. As páginas continuam protegidas individualmente (requireAdminPage). */
export const metadata: Metadata = {
  title: "Fio & Trato · Integrador ADS ↔ Mercado Livre",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <span className="brand">Fio &amp; Trato</span>
        <span className="brand-sub">Integrador ADS ↔ Mercado Livre</span>
        <nav className="nav" aria-label="Principal">
          <a href="/produtos">Produtos</a>
          <a href="/anuncios">Anúncios</a>
          <a href="/pedidos">Pedidos</a>
          <a href="/importacoes">Importações</a>
          <a href="/configuracoes/tabelas-de-preco">Tabelas de preço</a>
          <a href="/configuracoes/integracoes/mercadolivre">Mercado Livre</a>
          <a href="/configuracoes/integracoes/mercadolivre/monitoramento">Monitoramento</a>
        </nav>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
