import Image from "next/image";
import { company } from "@/content/lopes";
import s from "./site.module.css";

/**
 * Logo oficial da Lopes Cosméticos (extraído do catálogo da empresa).
 * `light` usa a versão clara, para fundos verde-petróleo.
 */
export function Logo({ light = false }: { light?: boolean }) {
  const file = light ? company.logoLight : company.logo;
  return (
    <a
      href="/#inicio"
      className={`${s.logo} ${light ? s.logoFooter : ""}`}
      aria-label={`${company.name} — início`}
    >
      {file ? (
        <Image src={file.src} alt={company.name} width={file.width} height={file.height} priority={!light} />
      ) : (
        <span className={s.logoText}>{company.shortName.toUpperCase()}</span>
      )}
    </a>
  );
}
