/**
 * Conteúdo institucional da Lopes Cosméticos.
 *
 * REGRA: somente dados confirmados. Campos com `null` não aparecem no site (nem em metadados ou
 * dados estruturados). Para publicar um dado, preencha o campo correspondente com o valor confirmado
 * pela empresa — nenhum componente precisa ser alterado.
 *
 * Origem dos dados atuais:
 *  - Catálogo oficial "Catálogo Lopes - Completo" (2026), enviado pela Lopes: logo, paleta, "desde 1983",
 *    "Distribuidora de cosméticos e perfumarias", slogan, "Uma nova fase", propósito, missão, visão,
 *    valores, segmentos atendidos, página "Nossas marcas", telefone (67) 3382-1892 e @lopescosmeticos.
 *  - Briefing desta fase: atuação B2B (vendas para CNPJ) e textos sugeridos do hero e do portal.
 */

export interface Brand {
  name: string;
  /** Linha complementar exibida sob o nome, como no catálogo (ex.: "Professional"). */
  detail?: string;
  /** Caminho em /public de um logo OFICIAL em boa resolução (ex.: "/marcas/davines.svg"). Sem logo, exibe o nome. */
  logo?: string | null;
}

export interface ImageSlot {
  /** Arquivo em /public (fotografia própria ou licenciada). Não usar imagens de instalações/equipe não autorizadas. */
  src: string;
  alt: string;
  width: number;
  height: number;
}

export const company = {
  name: "Lopes Cosméticos",
  shortName: "Lopes",
  descriptor: "Distribuidora de cosméticos e perfumarias",
  foundingYear: 1983,
  yearsText: "desde 1983",
  city: "Campo Grande",
  state: "Mato Grosso do Sul",
  stateCode: "MS",
  slogan: ["Tradição que inspira confiança.", "Evolução que gera crescimento."] as const,
  /** Logo oficial (extraído do catálogo). Versão clara para fundos escuros. */
  logo: { src: "/brand/lopes-logo.png", width: 399, height: 301 } as { src: string; width: number; height: number } | null,
  logoLight: { src: "/brand/lopes-logo-light.png", width: 399, height: 301 } as { src: string; width: number; height: number } | null,
  /** Razão social e CNPJ: exibir somente após confirmação do CNPJ institucional correto. */
  legalName: null as string | null,
  cnpj: null as string | null,
};

export const seo = {
  title: "Lopes Cosméticos | Distribuidora de cosméticos e perfumarias em Campo Grande, MS",
  description:
    "Desde 1983, a Lopes Cosméticos conecta marcas e pontos de venda do mercado da beleza. Distribuição B2B para salões, perfumarias, farmácias, supermercados e lojistas com CNPJ.",
  ogImageAlt: "Lopes Cosméticos — distribuidora de cosméticos e perfumarias em Campo Grande, MS, desde 1983",
};

export const contact = {
  /** Endereço completo confirmado. Enquanto null, exibe apenas cidade/UF. */
  address: null as string | null,
  /** WhatsApp comercial (ex.: "(67) 9 0000-0000"). Habilita o botão de WhatsApp. */
  whatsapp: null as string | null,
  whatsappMessage: "Olá! Gostaria de falar com o comercial da Lopes Cosméticos.",
  /** Telefone publicado no catálogo oficial. */
  phone: "(67) 3382-1892" as string | null,
  email: null as string | null,
  /** Ex.: "Segunda a sexta, das 8h às 18h". */
  hours: null as string | null,
  social: {
    instagram: "https://www.instagram.com/lopescosmeticos/" as string | null,
    facebook: null as string | null,
    linkedin: null as string | null,
  },
};

export const hero = {
  eyebrow: "Distribuidora de cosméticos e perfumarias · Desde 1983",
  title: "Tradição que conecta marcas, negócios e oportunidades.",
  /** Trecho do título exibido em destaque (dourado). */
  titleEmphasis: "marcas",
  subtitle:
    "Há mais de 40 anos, a Lopes Cosméticos conecta o mercado da beleza a marcas e produtos para impulsionar negócios.",
  primaryCta: "Sou lojista — Acessar pedidos",
  secondaryCta: "Conheça a Lopes",
  b2bNote: "Atendimento B2B · vendas destinadas a clientes com CNPJ",
  cardLabel: "Desde",
  highlights: ["Distribuidora de cosméticos e perfumarias", "Atendimento a empresas com CNPJ", "Campo Grande · Mato Grosso do Sul"],
  /** Fotografia opcional para o destaque (ver ImageSlot). */
  image: null as ImageSlot | null,
};

export const about = {
  eyebrow: "Lopes Cosméticos · Desde 1983",
  title: "Uma nova fase.",
  paragraphs: [
    "Após décadas construindo uma história sólida no mercado de distribuição, a empresa evolui seu posicionamento para atuar de forma ainda mais estratégica, conectando marcas exclusivas e pontos de venda através de um portfólio selecionado, atendimento consultivo e relacionamentos duradouros.",
    "Mantendo os valores que construíram sua reputação, a nova geração assume o desafio de fortalecer a presença da empresa nos segmentos profissional, semi-profissional e especializado, atendendo salões de beleza, perfumarias, farmácias, supermercados e lojistas que buscam diferenciação e rentabilidade.",
  ],
  objectiveIntro: "Nosso objetivo não é ser apenas uma distribuidora.",
  objective: "Nosso objetivo é ser a principal parceira de crescimento para marcas e clientes do mercado de beleza.",
  objectiveEmphasis: "parceira de crescimento",
  chainTitle: "Nosso papel na cadeia da beleza",
  chain: [
    { label: "Marcas", text: "Indústria nacional e internacional de cosméticos e perfumaria." },
    { label: "Lopes Cosméticos", text: "Curadoria de marcas, atendimento consultivo e distribuição." },
    { label: "Pontos de venda", text: "Salões, perfumarias, farmácias, supermercados e lojistas." },
  ],
  image: null as ImageSlot | null,
};

export const identity = {
  eyebrow: "Quem somos",
  statements: [
    { label: "Propósito", text: "Conectar pessoas, marcas e negócios que transformam a autoestima através da beleza." },
    {
      label: "Missão",
      text: "Distribuir produtos, conhecimento e oportunidades, gerando crescimento sustentável para clientes, parceiros e marcas.",
    },
    {
      label: "Visão",
      text: "Ser a distribuidora de beleza mais respeitada e influente do Mato Grosso do Sul, reconhecida pela excelência no relacionamento, na curadoria de marcas e na geração de resultados.",
    },
  ],
  valuesTitle: "Valores",
  values: [
    { title: "Legado", text: "Mais de quatro décadas construindo relações de confiança." },
    { title: "Excelência", text: "Buscar qualidade em cada atendimento, marca e negociação." },
    { title: "Relacionamento", text: "Parcerias construídas com proximidade, respeito e compromisso." },
    { title: "Honestidade", text: "A base de todas as decisões." },
    { title: "Evolução", text: "Inovar continuamente sem perder a essência." },
    { title: "Comprometimento", text: "Trabalhar para o crescimento sustentável de clientes e parceiros." },
  ],
  closing: "Grandes negócios são construídos por pessoas.",
  closingEmphasis: "por pessoas",
};

export const differentials = {
  eyebrow: "Nossos diferenciais",
  title: "Uma parceria construída sobre experiência e relacionamento.",
  items: [
    {
      icon: "experience",
      title: "Experiência de mercado",
      text: "Desde 1983 acompanhando a evolução do mercado da beleza e as necessidades de quem vende.",
    },
    {
      icon: "portfolio",
      title: "Curadoria de marcas",
      text: "Portfólio selecionado de marcas profissionais e de varejo, reunidas em um único parceiro comercial.",
    },
    {
      icon: "relationship",
      title: "Relacionamento duradouro",
      text: "Parcerias construídas com proximidade, respeito e compromisso com cada cliente.",
    },
    {
      icon: "expertise",
      title: "Atendimento consultivo",
      text: "Conhecimento do setor para orientar o mix de produtos de cada ponto de venda.",
    },
    {
      icon: "orders",
      title: "Facilidade para pedidos",
      text: "Portal de pedidos online para clientes comerciais consultarem o portfólio e realizarem pedidos.",
    },
  ] as const,
};

export const brands = {
  eyebrow: "Portfólio",
  title: "Nossas marcas.",
  intro: "Curadoria de marcas reconhecidas pelo mercado profissional e varejista.",
  /** Página "Nossas marcas" do catálogo oficial 2026. */
  items: [
    { name: "L'Oréal", detail: "Professionnel" },
    { name: "Matrix" },
    { name: "Davines" },
    { name: "Magic Beauty" },
    { name: "Schwarzkopf", detail: "Professional" },
    { name: "Braé" },
    { name: "Braé", detail: "Stages" },
    { name: "Nuance", detail: "Professional" },
    { name: "Eico" },
    { name: "Forever Liss", detail: "Professional" },
    { name: "Probelle", detail: "Professional" },
    { name: "Cuccio", detail: "Brasil" },
    { name: "Beira Alta" },
    { name: "Mascavo", detail: "Mariana Saad" },
    { name: "Payot" },
    { name: "Bauny", detail: "Cosméticos" },
    { name: "Ga.Ma", detail: "Italy Professional" },
  ] satisfies Brand[],
  disclaimer:
    "Disponibilidade de marcas e produtos sujeita às políticas comerciais vigentes. Os nomes e marcas citados pertencem aos seus respectivos titulares.",
};

export const segments = {
  eyebrow: "Para lojistas",
  title: "Distribuição para quem faz o mercado da beleza acontecer.",
  intro:
    "Atuamos nos segmentos profissional, semi-profissional e especializado, atendendo pontos de venda que buscam diferenciação e rentabilidade.",
  items: [
    { icon: "salon", title: "Salões de beleza", text: "Linhas profissionais para o atendimento no salão e para revenda." },
    { icon: "perfumery", title: "Perfumarias", text: "Marcas desejadas para compor um mix atrativo e competitivo." },
    { icon: "pharmacy", title: "Farmácias", text: "Cuidados pessoais e beleza para o varejo farmacêutico." },
    { icon: "cart", title: "Supermercados", text: "Marcas de beleza e cuidados pessoais para o varejo alimentar." },
    { icon: "store", title: "Lojistas", text: "Lojas de cosméticos e negócios da beleza que buscam diferenciação." },
  ] as const,
  b2bTitle: "Atendimento exclusivamente B2B",
  b2bText:
    "As vendas da Lopes Cosméticos são destinadas a empresas e profissionais com CNPJ, elegíveis conforme a política comercial vigente.",
};

export const portalCta = {
  eyebrow: "Portal de pedidos",
  title: "Seu negócio merece um parceiro à altura.",
  text: "Explore nosso portfólio e tenha acesso ao portal de pedidos da Lopes Cosméticos.",
  button: "Acessar portal de pedidos",
  note: "Portal destinado a clientes comerciais com CNPJ.",
  /** Texto do botão enquanto NEXT_PUBLIC_B2B_PORTAL_URL não estiver configurada. */
  fallbackButton: "Fale com o comercial",
};

export const contactSection = {
  eyebrow: "Contato",
  title: "Vamos conversar sobre o seu negócio.",
  intro: "Fale com a Lopes Cosméticos pelos canais oficiais abaixo.",
};

export const footer = {
  description:
    "Distribuidora de cosméticos e perfumarias desde 1983, conectando marcas e pontos de venda do mercado da beleza a partir de Campo Grande, MS.",
};
