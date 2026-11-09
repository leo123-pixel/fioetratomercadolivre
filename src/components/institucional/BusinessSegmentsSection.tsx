import { segments } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { Icon } from "./icons";
import { PortalLink } from "./PortalLink";
import s from "./site.module.css";

function CheckList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <h3 className={s.checkTitle}>{title}</h3>
      <ul className={s.checkList}>
        {items.map((item) => (
          <li key={item}>
            <span className={s.checkIcon} aria-hidden="true">
              <Icon name="check" size={11} strokeWidth={3} />
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Card verde-petróleo: portal de pedidos + para quem a Lopes distribui (B2B). */
export function BusinessSegmentsSection() {
  return (
    <section id={SECTION_IDS.lojistas} className={s.section} aria-labelledby="lojistas-title">
      <div className={s.productCard}>
        <div className={s.productCardInner}>
          <div>
            <span className={s.labelLight}>{segments.label}</span>
            <h2 id="lojistas-title" className={s.h2}>
              {segments.title}
            </h2>
            <p>{segments.text}</p>
            <span className={s.productMeta}>{segments.b2bLabel}</span>
            <div className={s.productActions}>
              <PortalLink className={s.btnLight} label={segments.button} />
            </div>
          </div>
          <div className={s.checkCols}>
            <CheckList title={segments.segmentsTitle} items={segments.items} />
            <CheckList title={segments.marketsTitle} items={segments.markets} />
            <p className={s.policy}>{segments.policy}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
