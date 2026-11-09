import { brands, chain } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

const fx = (delay: number) => ({ "data-fx": "", style: { ["--d" as string]: `${delay}ms` } });

/**
 * Card claro: a cadeia da beleza em três camadas (marcas → Lopes → pontos de venda), que se separam
 * ao entrar na tela, e os diferenciais.
 */
export function DifferentialsSection() {
  const [top, middle, bottom] = chain.layers;
  return (
    <section id={SECTION_IDS.diferenciais} className={s.section} aria-labelledby="diferenciais-title">
      <div className={s.bigCard}>
        <div className={`${s.fx} ${s.bigCardInner}`} {...fx(0)}>
          <div className={s.bigCardHead}>
            <h2 id="diferenciais-title" className={s.h2}>
              <RevealText text={chain.title} />
            </h2>
            <p className={s.lead}>{chain.text}</p>
          </div>

          <div className={s.bigCardBody}>
            <div className={s.layersWrap} aria-hidden="true">
              <div className={s.layers} data-fx="">
                <div className={`${s.layer} ${s.layerBottom}`}>
                  <span className={s.layerLabel}>{bottom.label}</span>
                </div>
                <div className={`${s.layer} ${s.layerMiddle}`}>
                  <span className={s.layerLabel}>{middle.label}</span>
                </div>
                <div className={`${s.layer} ${s.layerTop}`}>
                  <span className={s.layerChips}>
                    {Array.from({ length: Math.min(6, brands.items.length) }, (_, index) => (
                      <span key={index} className={s.layerChip} />
                    ))}
                  </span>
                  <span className={s.layerLabel}>{top.label}</span>
                </div>
              </div>
            </div>

            <div className={s.featureCol}>
              <span className={s.label}>{chain.layersLabel}</span>
              <ul className={s.featureList}>
                {chain.layers.map((layer, index) => (
                  <li key={layer.label} className={`${s.fx} ${s.feature}`} {...fx(200 + index * 150)}>
                    <h3>{layer.label}</h3>
                    <p>{layer.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <ul className={s.differentials}>
            {chain.differentials.map((item, index) => (
              <li key={item.title} className={s.fx} {...fx(index * 120)}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
