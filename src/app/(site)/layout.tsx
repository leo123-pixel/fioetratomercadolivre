import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import { InstitutionalFooter } from "@/components/institucional/InstitutionalFooter";
import { InstitutionalHeader } from "@/components/institucional/InstitutionalHeader";
import s from "@/components/institucional/site.module.css";
import { company, seo } from "@/content/lopes";
import "./site-globals.css";

// Tipografia geométrica sem serifa, como no catálogo oficial da Lopes.
// Fonte variável (um único arquivo cobre todos os pesos usados: 300–600).
const font = Montserrat({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-lopes",
});

export const metadata: Metadata = {
  title: { default: seo.title, template: `%s | ${company.name}` },
  description: seo.description,
  applicationName: company.name,
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "pt_BR",
    siteName: company.name,
    title: seo.title,
    description: seo.description,
  },
  twitter: { card: "summary_large_image", title: seo.title, description: seo.description },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#053839",
  colorScheme: "light",
};

/** Site institucional público (sem autenticação). Separado da área administrativa e do portal B2B. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${font.variable} ${s.site}`}>
      <a href="#conteudo" className={s.skipLink}>
        Pular para o conteúdo
      </a>
      <InstitutionalHeader />
      <main id="conteudo" tabIndex={-1}>
        {children}
      </main>
      <InstitutionalFooter />
    </div>
  );
}
