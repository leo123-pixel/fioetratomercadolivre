import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { company, contact } from "@/content/lopes";
import {
  ADMIN_LOGIN_HREF,
  DEFAULT_B2B_PORTAL_URL,
  parsePortalUrl,
  portalHref,
  PRIVATE_PATHS,
  siteUrl,
  telHref,
  whatsappHref,
} from "@/lib/site/links";
import { organizationJsonLd } from "@/lib/site/structured-data";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("site institucional: portal B2B", () => {
  it("aceita apenas https (http só em localhost)", () => {
    expect(parsePortalUrl("https://pedidos.exemplo.com.br/login")).toBe("https://pedidos.exemplo.com.br/login");
    expect(parsePortalUrl("http://localhost:4000")).toBe("http://localhost:4000/");
    expect(parsePortalUrl("http://pedidos.exemplo.com.br")).toBeNull();
    expect(parsePortalUrl("javascript:alert(1)")).toBeNull();
    expect(parsePortalUrl("não é url")).toBeNull();
    expect(parsePortalUrl("")).toBeNull();
    expect(parsePortalUrl(undefined)).toBeNull();
  });

  it("sem NEXT_PUBLIC_B2B_PORTAL_URL, usa o portal informado pela Lopes", () => {
    vi.stubEnv("NEXT_PUBLIC_B2B_PORTAL_URL", "");
    expect(DEFAULT_B2B_PORTAL_URL).toBe("https://pedidos.tecdisa.com.br/Identity/Account/Login?key=00203406000171");
    expect(portalHref()).toEqual({ href: DEFAULT_B2B_PORTAL_URL, external: true });
  });

  it("variável inválida não derruba o link: cai no portal padrão", () => {
    vi.stubEnv("NEXT_PUBLIC_B2B_PORTAL_URL", "http://inseguro.exemplo.com");
    expect(portalHref().href).toBe(DEFAULT_B2B_PORTAL_URL);
  });

  it("com a variável configurada, abre o portal existente por link direto", () => {
    vi.stubEnv("NEXT_PUBLIC_B2B_PORTAL_URL", "https://portal.exemplo.com.br");
    expect(portalHref()).toEqual({ href: "https://portal.exemplo.com.br/", external: true });
  });
});

describe("site institucional: área administrativa", () => {
  it("reutiliza o login existente e mantém /produtos como destino", () => {
    expect(ADMIN_LOGIN_HREF).toBe("/login?next=%2Fprodutos");
  });

  it("robots.txt bloqueia admin e APIs e libera o site", () => {
    vi.stubEnv("APP_BASE_URL", "https://fioetrato-ml.vercel.app");
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rule.allow).toBe("/");
    for (const path of ["/api/", "/login", "/produtos", "/anuncios", "/pedidos", "/importacoes", "/configuracoes"]) {
      expect(rule.disallow).toContain(path);
    }
    expect(result.sitemap).toBe("https://fioetrato-ml.vercel.app/sitemap.xml");
  });

  it("sitemap contém só páginas públicas", () => {
    vi.stubEnv("APP_BASE_URL", "https://fioetrato-ml.vercel.app/");
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(["https://fioetrato-ml.vercel.app/", "https://fioetrato-ml.vercel.app/politica-de-privacidade"]);
    for (const url of urls) {
      expect(PRIVATE_PATHS.some((p) => new URL(url).pathname.startsWith(p))).toBe(false);
    }
  });
});

describe("site institucional: dados", () => {
  it("siteUrl usa APP_BASE_URL e cai para localhost", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("APP_BASE_URL", "https://exemplo.com/");
    expect(siteUrl()).toBe("https://exemplo.com");
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  it("monta links de WhatsApp e telefone somente com números válidos", () => {
    expect(whatsappHref("(67) 99999-0000", "Olá")).toBe("https://wa.me/5567999990000?text=Ol%C3%A1");
    expect(whatsappHref("123")).toBeNull();
    expect(whatsappHref(null)).toBeNull();
    expect(telHref("(67) 3333-0000")).toBe("tel:+556733330000");
    expect(telHref("")).toBeNull();
  });

  it("dados estruturados não incluem campos não confirmados", () => {
    const data = organizationJsonLd();
    expect(data["@type"]).toBe("Organization");
    expect(data.name).toBe(company.name);
    if (!company.cnpj) expect(data).not.toHaveProperty("taxID");
    if (!contact.phone) expect(data).not.toHaveProperty("telephone");
    if (!contact.email) expect(data).not.toHaveProperty("email");
    // Ano de fundação confirmado no catálogo oficial ("Desde 1983").
    expect(data.foundingDate).toBe("1983");
    if (contact.phone) expect(data.telephone).toBe("+556733821892");
  });
});
