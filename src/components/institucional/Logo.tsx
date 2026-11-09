import Image from "next/image";
import { company } from "@/content/lopes";
import s from "./site.module.css";

/**
 * Logo da Lopes Cosméticos. Usa o arquivo oficial quando `company.logo` estiver configurado;
 * até lá, exibe o nome da empresa em texto (não é uma recriação do logotipo).
 */
export function Logo({ light = false }: { light?: boolean }) {
  return (
    <a href="/#inicio" className={light ? s.logoLight : s.logo} aria-label={`${company.name} — início`}>
      {company.logo ? (
        <Image src={company.logo.src} alt={company.name} width={company.logo.width} height={company.logo.height} priority={!light} />
      ) : (
        <>
          <span className={s.logoMark}>{company.shortName}</span>
          <span className={s.logoSub}>Cosméticos</span>
        </>
      )}
    </a>
  );
}
