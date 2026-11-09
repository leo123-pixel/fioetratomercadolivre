import type { Metadata } from "next";
import { AboutSection } from "@/components/institucional/AboutSection";
import { B2BPortalCTA } from "@/components/institucional/B2BPortalCTA";
import { BrandsSection } from "@/components/institucional/BrandsSection";
import { BusinessSegmentsSection } from "@/components/institucional/BusinessSegmentsSection";
import { ContactSection } from "@/components/institucional/ContactSection";
import { DifferentialsSection } from "@/components/institucional/DifferentialsSection";
import { HeroSection } from "@/components/institucional/HeroSection";
import { IdentitySection } from "@/components/institucional/IdentitySection";
import { NumbersSection } from "@/components/institucional/NumbersSection";
import { organizationJsonLd } from "@/lib/site/structured-data";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { url: "/" },
};

// Página estática; revalida diariamente (ano do rodapé e variáveis públicas).
export const revalidate = 86400;

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        // JSON gerado no servidor a partir de dados confirmados; "<" escapado para não fechar a tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd()).replace(/</g, "\\u003c") }}
      />
      <HeroSection />
      <BrandsSection />
      <AboutSection />
      <DifferentialsSection />
      <BusinessSegmentsSection />
      <NumbersSection />
      <IdentitySection />
      <ContactSection />
      <B2BPortalCTA />
    </>
  );
}
