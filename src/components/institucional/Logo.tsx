import Image from "next/image";
import { company } from "@/content/lopes";
import s from "./site.module.css";

/** Logo oficial da Lopes Cosméticos (extraído do catálogo da empresa). */
export function Logo() {
  return (
    <a href="/#inicio" className={s.logo} aria-label={`${company.name} — início`}>
      {company.logo ? (
        <Image src={company.logo.src} alt={company.name} width={company.logo.width} height={company.logo.height} priority />
      ) : (
        <span className={s.logoText}>{company.shortName.toUpperCase()}</span>
      )}
    </a>
  );
}
