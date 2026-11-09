import Image from "next/image";
import { brands } from "@/content/lopes";
import type { Brand } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import s from "./site.module.css";

/**
 * Grade de marcas. Exibe o logo oficial quando houver arquivo autorizado em /public;
 * caso contrário, o nome da marca em tipografia uniforme (sem recriar logotipos).
 */
export function BrandsSection() {
  const items: Brand[] = brands.items;
  return (
    <section id={SECTION_IDS.marcas} className={s.sectionBeige} aria-labelledby="marcas-title">
      <div className={s.container}>
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>{brands.eyebrow}</p>
          <h2 id="marcas-title" className={s.h2}>
            {brands.title}
          </h2>
          <p className={s.lead}>{brands.intro}</p>
        </div>
        <ul className={s.brandGrid}>
          {items.map((brand) => (
            <li key={`${brand.name}-${brand.detail ?? ""}`} className={s.brandItem}>
              {brand.logo ? (
                <Image
                  src={brand.logo}
                  alt={[brand.name, brand.detail].filter(Boolean).join(" ")}
                  width={150}
                  height={56}
                  loading="lazy"
                  className={s.brandLogo}
                />
              ) : (
                <>
                  <span className={s.brandName}>{brand.name}</span>
                  {brand.detail && <span className={s.brandDetail}>{brand.detail}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
        <p className={s.disclaimer}>{brands.disclaimer}</p>
      </div>
    </section>
  );
}
