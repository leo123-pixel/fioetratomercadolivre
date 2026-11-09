import type { Metadata, Viewport } from "next";
import { siteUrl } from "@/lib/site/links";

/**
 * Layout raiz compartilhado por três contextos separados:
 *  - (site)  → site institucional público da Lopes Cosméticos (rota "/")
 *  - (admin) → integrador ADS ↔ Mercado Livre, protegido por sessão (rotas e URLs inalteradas)
 *  - api/    → endpoints, webhooks e OAuth (inalterados)
 * Cada grupo carrega o próprio CSS e cabeçalho. Por padrão nada é indexado; o site libera a indexação
 * apenas nas suas páginas públicas.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
