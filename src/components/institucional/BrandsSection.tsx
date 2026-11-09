import { brands } from "@/content/lopes";
import type { Brand } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { BrandMarquee } from "./BrandMarquee";
import s from "./site.module.css";

/**
 * Faixa de marcas em rolagem contínua. Sem logos oficiais em boa resolução, exibe o nome de cada
 * marca — não recria logotipos.
 */
export function BrandsSection() {
  const items: Brand[] = brands.items;
  return (
    <section id={SECTION_IDS.marcas} className={s.brandsStrip} aria-labelledby="marcas-title">
      <BrandMarquee items={items} title={brands.label} titleId="marcas-title" />
      <p className={s.brandsNote}>{brands.disclaimer}</p>
    </section>
  );
}
