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
 *  - Portal de pedidos: endereço informado pela Lopes (ver DEFAULT_B2B_PORTAL_URL em src/lib/site/links.ts).
 */

export interface Brand {
  name: string;
  /** Linha complementar exibida sob o nome, como no catálogo (ex.: "Professional"). */
  detail?: string;
  /** Caminho em /public de um logo OFICIAL em boa resolução (ex.: "/marcas/davines.svg"). Sem logo, exibe o nome. */
  logo?: string | null;
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
  title: "Lopes Cosméticos | Distribuidora de cosméticos e perfumarias",
  description:
    "Desde 1983, a Lopes Cosméticos conecta marcas e pontos de venda do mercado da beleza. Distribuição B2B para salões, perfumarias, farmácias, supermercados e lojistas com CNPJ.",
  ogImageAlt: "Lopes Cosméticos — distribuidora de cosméticos e perfumarias desde 1983",
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

export const announcement = {
  text: "Portal de pedidos Lopes — exclusivo para clientes com CNPJ",
};

export const hero = {
  label: "Distribuidora de cosméticos e perfumarias",
  title: "Tradição que conecta marcas, negócios e oportunidades.",
  subtitle:
    "Há mais de 40 anos, a Lopes Cosméticos conecta o mercado da beleza a marcas e produtos para impulsionar negócios.",
  primaryCta: "Sou lojista — Acessar pedidos",
  secondaryCta: "Conheça a Lopes",
  b2bNote: "Atendimento B2B · vendas destinadas a clientes com CNPJ",
  /** Composição do topo (inspirada em cards de interface). Apenas fatos confirmados. */
  promptCard: "Conectamos marcas e pontos de venda do mercado da beleza desde 1983.",
  steps: ["Curadoria de marcas", "Atendimento consultivo", "Pedido pelo portal", "Distribuição"],
  tags: ["Salões de beleza", "Perfumarias", "Farmácias", "Supermercados", "Lojistas"],
};

export const brands = {
  label: "Marcas do nosso portfólio",
  title: "Nossas marcas.",
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

/** Bloco escuro "Uma nova fase" (texto do catálogo). */
export const about = {
  label: "Uma nova fase",
  statementMuted: "Mais que uma distribuidora.",
  statement: "Uma parceira de crescimento.",
  paragraphs: [
    "Após décadas construindo uma história sólida no mercado de distribuição, a empresa evolui seu posicionamento para atuar de forma ainda mais estratégica, conectando marcas exclusivas e pontos de venda através de um portfólio selecionado, atendimento consultivo e relacionamentos duradouros.",
    "Mantendo os valores que construíram sua reputação, a nova geração assume o desafio de fortalecer a presença da empresa nos segmentos profissional, semi-profissional e especializado, atendendo salões de beleza, perfumarias, farmácias, supermercados e lojistas que buscam diferenciação e rentabilidade.",
  ],
  objective: "Nosso objetivo é ser a principal parceira de crescimento para marcas e clientes do mercado de beleza.",
};

/** Card das três camadas da cadeia + diferenciais. */
export const chain = {
  title: "A cadeia da beleza, conectada",
  text: "Entre a indústria e o ponto de venda, a Lopes seleciona marcas, orienta o mix de cada cliente e simplifica a compra — com a proximidade de quem está no mercado desde 1983.",
  layersLabel: "Uma distribuidora, três elos",
  layers: [
    { label: "Marcas", text: "Indústria nacional e internacional de cosméticos e perfumaria." },
    { label: "Lopes Cosméticos", text: "Curadoria de marcas, atendimento consultivo e distribuição." },
    { label: "Pontos de venda", text: "Salões, perfumarias, farmácias, supermercados e lojistas." },
  ],
  differentials: [
    { title: "Experiência de mercado", text: "Desde 1983 acompanhando a evolução do mercado da beleza." },
    { title: "Curadoria de marcas", text: "Portfólio selecionado de marcas profissionais e de varejo." },
    { title: "Relacionamento duradouro", text: "Parcerias construídas com proximidade, respeito e compromisso." },
    { title: "Atendimento consultivo", text: "Orientação para o mix de produtos de cada ponto de venda." },
  ],
};

/** Card do portal / segmentos (bloco verde-petróleo). */
export const segments = {
  label: "Para lojistas",
  title: "Portal de pedidos Lopes",
  text: "Explore nosso portfólio e tenha acesso ao portal de pedidos da Lopes Cosméticos.",
  b2bLabel: "Exclusivo para clientes com CNPJ",
  button: "Acessar portal de pedidos",
  segmentsTitle: "Quem atendemos",
  items: ["Salões de beleza", "Perfumarias", "Farmácias", "Supermercados", "Lojistas"],
  marketsTitle: "Segmentos de atuação",
  markets: ["Profissional", "Semi-profissional", "Especializado", "Vendas B2B para CNPJ"],
  policy:
    "As vendas da Lopes Cosméticos são destinadas a empresas e profissionais com CNPJ, elegíveis conforme a política comercial vigente.",
};

/** Números — todos verificáveis no catálogo oficial. */
export const numbers = {
  title: "Uma trajetória que se mede em relações de confiança",
  items: [
    { value: "1983", label: "ano de fundação", text: "Uma história construída ao lado do mercado da beleza." },
    { value: "40+", label: "anos de mercado", text: "Mais de quatro décadas construindo relações de confiança." },
    { value: "17", label: "marcas no portfólio", text: "Marcas profissionais e de varejo selecionadas pela Lopes." },
    { value: "5", label: "canais atendidos", text: "Salões, perfumarias, farmácias, supermercados e lojistas." },
  ],
};

export const identity = {
  label: "Quem somos",
  titleMuted: "Grandes negócios são",
  title: "construídos por pessoas.",
  text: "Propósito, missão e visão que orientam cada atendimento, marca e negociação da Lopes Cosméticos.",
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
};

export const contactSection = {
  label: "Contato",
  title: "Fale com a Lopes.",
  intro: "Atendimento comercial para empresas e profissionais do mercado da beleza.",
};

export const portalCta = {
  title: "Seu negócio merece um parceiro à altura.",
  text: "Explore nosso portfólio e tenha acesso ao portal de pedidos da Lopes Cosméticos.",
  button: "Acessar portal de pedidos",
  secondary: "Falar com o comercial",
  /** Texto do botão caso o portal fique sem URL válida. */
  fallbackButton: "Fale com o comercial",
};

export const footer = {
  description:
    "Distribuidora de cosméticos e perfumarias desde 1983, conectando marcas e pontos de venda do mercado da beleza.",
};
