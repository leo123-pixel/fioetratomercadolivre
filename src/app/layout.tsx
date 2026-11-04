import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fio & Trato · Integrador ADS ↔ Mercado Livre",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <header className="topbar">
          <span className="brand">Fio &amp; Trato</span>
          <span className="brand-sub">Integrador ADS ↔ Mercado Livre</span>
          <nav className="nav" aria-label="Principal">
            <a href="/produtos">Produtos</a>
            <a href="/anuncios">Anúncios</a>
            <a href="/importacoes">Importações</a>
            <a href="/configuracoes/tabelas-de-preco">Tabelas de preço</a>
            <a href="/configuracoes/integracoes/mercadolivre">Mercado Livre</a>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
