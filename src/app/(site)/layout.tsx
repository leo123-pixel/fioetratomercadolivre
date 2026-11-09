import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import { InstitutionalFooter } from "@/components/institucional/InstitutionalFooter";
import { InstitutionalHeader } from "@/components/institucional/InstitutionalHeader";
import s from "@/components/institucional/site.module.css";
import { company, seo } from "@/content/lopes";
import "./site-globals.css";

const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-lopes-display",
});

const body = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-lopes-body",
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
  themeColor: "#fbf8f4",
  colorScheme: "light",
};

/** Site institucional público (sem autenticação). Separado da área administrativa e do portal B2B. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${display.variable} ${body.variable} ${s.site}`}>
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
