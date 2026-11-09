"use client";

import Image from "next/image";
import { useState } from "react";
import type { Brand } from "@/content/lopes";
import { Icon } from "./icons";
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
 * Faixa de marcas em rolagem contínua, com botão de pausar (conteúdo em movimento precisa de
 * controle de pausa — WCAG 2.2.2). A segunda cópia da lista é decorativa (aria-hidden).
 */
export function BrandMarquee({ items, title, titleId }: { items: Brand[]; title: string; titleId: string }) {
  const [paused, setPaused] = useState(false);
  return (
    <>
      <div className={s.brandsHead}>
        <h2 id={titleId}>{title}</h2>
        <div className={s.brandsMeta}>
        <span className={`${s.mono} ${s.muted}`}>{items.length} marcas</span>
        <button
          type="button"
          className={s.pauseButton}
          onClick={() => setPaused((value) => !value)}
          aria-pressed={paused}
          aria-label={paused ? "Retomar a rolagem das marcas" : "Pausar a rolagem das marcas"}
        >
          <Icon name={paused ? "play" : "pause"} size={14} />
        </button>
        </div>
      </div>
      <div className={s.marquee} data-paused={paused ? "true" : undefined}>
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
    </>
  );
}
