import { company, contact, seo } from "@/content/lopes";
import { siteUrl, telHref } from "./links";

/** schema.org Organization somente com dados confirmados (campos nulos são omitidos). */
export function organizationJsonLd(): Record<string, unknown> {
  const url = siteUrl();
  const sameAs = Object.values(contact.social).filter((value): value is string => Boolean(value));
  const phone = telHref(contact.phone)?.replace("tel:", "");

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: company.name,
    url: `${url}/`,
    description: seo.description,
    address: {
      "@type": "PostalAddress",
      addressLocality: company.city,
      addressRegion: company.stateCode,
      addressCountry: "BR",
      ...(contact.address ? { streetAddress: contact.address } : {}),
    },
    areaServed: { "@type": "State", name: company.state },
  };
  if (company.legalName) data.legalName = company.legalName;
  if (company.cnpj) data.taxID = company.cnpj;
  if (company.logo) data.logo = `${url}${company.logo.src}`;
  if (contact.email) data.email = contact.email;
  if (phone) data.telephone = phone;
  if (sameAs.length) data.sameAs = sameAs;
  return data;
}
