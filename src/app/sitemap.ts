import type { MetadataRoute } from "next";
import { PRIVACY_PATH, siteUrl } from "@/lib/site/links";

/** Apenas páginas públicas do site institucional. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    { url: `${base}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${base}${PRIVACY_PATH}`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
