import { portalCta } from "@/content/lopes";
import { portalHref } from "@/lib/site/links";
import { Icon } from "./icons";

/**
 * Botão/link para o portal de pedidos B2B existente (link direto, sem iframe, sem nova autenticação).
 * Enquanto NEXT_PUBLIC_B2B_PORTAL_URL não estiver configurada, leva à seção de contato.
 */
export function PortalLink({
  className,
  label,
  icon = "arrowUpRight",
  onNavigate,
}: {
  className?: string;
  label: string;
  icon?: "arrowUpRight" | "arrowRight" | null;
  onNavigate?: () => void;
}) {
  const { href, external } = portalHref();
  const text = external ? label : portalCta.fallbackButton;
  return (
    <a
      href={href}
      className={className}
      onClick={onNavigate}
      rel={external ? "noopener" : undefined}
      data-portal={external ? "configured" : "missing"}
    >
      {text}
      {icon && <Icon name={external ? icon : "arrowRight"} size={18} />}
    </a>
  );
}
