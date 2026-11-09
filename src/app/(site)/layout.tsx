import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { InstitutionalFooter } from "@/components/institucional/InstitutionalFooter";
import { InstitutionalHeader } from "@/components/institucional/InstitutionalHeader";
import s from "@/components/institucional/site.module.css";
import { company, seo } from "@/content/lopes";
import "./site-globals.css";

// Fontes variáveis (sem lista de pesos: o next/font falhou no build da Vercel com pesos explícitos).
// Grotesca para títulos e texto; mono para rótulos.
const font = Inter_Tight({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-lopes",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-lopes-mono",
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
  themeColor: "#f0eee6",
  colorScheme: "light",
};

/** Site institucional público (sem autenticação). Separado da área administrativa e do portal B2B. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${font.variable} ${mono.variable} ${s.site}`}>
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
