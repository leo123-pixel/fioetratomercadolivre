/**
 * Links e URLs do site institucional. Sem dependências de servidor: usado em Server e Client Components.
 *
 * Três contextos separados:
 *  - Site institucional: "/" (público)
 *  - Área administrativa: login existente do integrador ("/login"), páginas protegidas por sessão
 *  - Portal B2B: aplicação externa, definida por NEXT_PUBLIC_B2B_PORTAL_URL (abre por link direto)
 */

/**
 * Login administrativo já existente. Antes do site, "/" levava o administrador para /produtos;
 * o parâmetro next preserva esse destino depois do login.
 */
export const ADMIN_LOGIN_HREF = "/login?next=%2Fprodutos";

/** Âncoras da página inicial. */
export const SECTION_IDS = {
  inicio: "inicio",
  sobre: "sobre",
  quemSomos: "quem-somos",
  diferenciais: "diferenciais",
  marcas: "marcas",
  lojistas: "lojistas",
  portal: "portal",
  contato: "contato",
} as const;

export const NAV_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Início", href: `/#${SECTION_IDS.inicio}` },
  { label: "Sobre nós", href: `/#${SECTION_IDS.sobre}` },
  { label: "Nossas marcas", href: `/#${SECTION_IDS.marcas}` },
  { label: "Para lojistas", href: `/#${SECTION_IDS.lojistas}` },
  { label: "Contato", href: `/#${SECTION_IDS.contato}` },
];

export const PRIVACY_PATH = "/politica-de-privacidade";

/** Prefixos da área administrativa e das APIs: nunca indexados (as páginas também enviam noindex). */
export const PRIVATE_PATHS = [
  "/api/",
  "/login",
  "/produtos",
  "/anuncios",
  "/pedidos",
  "/importacoes",
  "/configuracoes",
] as const;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Origem pública do site (canonical, sitemap, Open Graph). */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL || process.env.APP_BASE_URL;
  if (explicit) {
    try {
      return trimSlash(new URL(explicit).origin);
    } catch {
      /* valor inválido: usa o próximo candidato */
    }
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${trimSlash(vercel)}`;
  return "http://localhost:3000";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Valida a URL do portal B2B. Aceita apenas https (http só para endereços locais de desenvolvimento).
 * Retorna null quando ausente ou inválida — a interface então sinaliza a pendência.
 */
export function parsePortalUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return url.toString();
  return null;
}

/** URL do portal de pedidos B2B existente (NEXT_PUBLIC_B2B_PORTAL_URL), ou null se não configurada. */
export function b2bPortalUrl(): string | null {
  return parsePortalUrl(process.env.NEXT_PUBLIC_B2B_PORTAL_URL);
}

/** Destino dos botões do portal: o portal, ou a seção de contato enquanto a URL não estiver configurada. */
export function portalHref(): { href: string; external: boolean } {
  const url = b2bPortalUrl();
  return url ? { href: url, external: true } : { href: `/#${SECTION_IDS.contato}`, external: false };
}

/** Link "wa.me" a partir de um número brasileiro. Retorna null se o número não for válido. */
export function whatsappHref(phone: string | null | undefined, message?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits)) return null;
  const text = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${digits}${text}`;
}

/** Link "tel:" a partir de um número brasileiro. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `tel:+${digits.startsWith("55") ? digits : `55${digits}`}`;
}
