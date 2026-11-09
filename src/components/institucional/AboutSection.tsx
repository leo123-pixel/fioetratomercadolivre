import { about } from "@/content/lopes";
import { SECTION_IDS } from "@/lib/site/links";
import { RevealText } from "./RevealText";
import s from "./site.module.css";

/** Bloco escuro de largura total: declaração em duas cores + texto "Uma nova fase" do catálogo. */
export function AboutSection() {
  return (
    <section id={SECTION_IDS.sobre} className={s.dark} aria-labelledby="sobre-title">
      <div className={s.split}>
        <div>
          <span className={s.labelLight}>{about.label}</span>
          <h2 id="sobre-title" className={s.h2}>
            <RevealText text={about.statementMuted} className={s.mutedLight} />{" "}
            <RevealText text={about.statement} offset={4} />
          </h2>
        </div>
        <div className={s.darkText}>
          {about.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 32)}>{paragraph}</p>
          ))}
          <p className={s.objective}>{about.objective}</p>
        </div>
      </div>
    </section>
  );
}
