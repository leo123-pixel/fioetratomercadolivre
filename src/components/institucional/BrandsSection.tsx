import Image from "next/image";
import { brands } from "@/content/lopes";
import type { Brand } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import s from "./site.module.css";

function BrandMark({ brand }: { brand: Brand }) {
  if (brand.logo) {
    return (
      <Image
        src={brand.logo}
        alt={[brand.name, brand.detail].filter(Boolean).join(" ")}
        width={160}
        height={40}
        loading="lazy"
        className={s.brandLogo}
      />
    );
  }
  return (
    <span className={s.brandMark}>
      <span className={s.brandMarkName}>{brand.name}</span>
      {brand.detail && <span className={s.brandMarkDetail}>{brand.detail}</span>}
    </span>
  );
}

/**
 * Faixa de marcas em rolagem contínua (pausa ao passar o mouse; parada e em grade com
 * prefers-reduced-motion). A segunda cópia da lista é decorativa (aria-hidden).
 * Sem logos oficiais em boa resolução, exibe o nome de cada marca — não recria logotipos.
 */
export function BrandsSection() {
  const items: Brand[] = brands.items;
  return (
    <section id={SECTION_IDS.marcas} className={s.brandsStrip} aria-labelledby="marcas-title">
      <div className={s.brandsHead}>
        <h2 id="marcas-title">{brands.label}</h2>
        <span className={`${s.mono} ${s.muted}`}>{items.length} marcas</span>
      </div>
      <div className={s.marquee}>
        <div className={s.marqueeTrack}>
          {[0, 1].map((copy) => (
            <ul key={copy} className={s.marqueeList} aria-hidden={copy === 1 ? true : undefined}>
              {items.map((brand) => (
                <li key={`${copy}-${brand.name}-${brand.detail ?? ""}`}>
                  <BrandMark brand={brand} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
      <p className={s.brandsNote}>{brands.disclaimer}</p>
    </section>
  );
}
