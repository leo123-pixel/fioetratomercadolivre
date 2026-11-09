/**
 * Conteúdo institucional da Lopes Cosméticos.
 *
 * REGRA: somente dados confirmados. Campos com `null` não aparecem no site (nem em metadados ou
 * dados estruturados). Para publicar um dado, preencha o campo correspondente com o valor confirmado
 * pela empresa — nenhum componente precisa ser alterado.
 *
 * Origem dos dados atuais:
 *  - Nome, atuação B2B (vendas para CNPJ), "mais de 40 anos", Campo Grande/MS, segmentos e lista
 *    inicial de marcas: briefing da Lopes para esta fase.
 *  - Instagram @lopescosmeticos: perfil público "Lopes | Distribuidora de Cosméticos" (MS). Confirmar.
 */

export interface Brand {
  name: string;
  /** Caminho em /public de um logo OFICIAL autorizado (ex.: "/marcas/davines.svg"). Sem logo, exibe o nome. */
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
  descriptor: "Distribuidora de cosméticos",
  yearsLabel: "40+",
  yearsText: "mais de 40 anos",
  city: "Campo Grande",
  state: "Mato Grosso do Sul",
  stateCode: "MS",
  /** Logo oficial em /public (ex.: "/brand/lopes-logo.svg"). Enquanto null, o cabeçalho usa o nome em texto. */
  logo: null as { src: string; width: number; height: number } | null,
  /** Razão social e CNPJ: exibir somente após confirmação do CNPJ institucional correto. */
  legalName: null as string | null,
  cnpj: null as string | null,
};

export const seo = {
  title: "Lopes Cosméticos | Distribuidora de cosméticos em Campo Grande, MS",
  description:
    "Há mais de 40 anos, a Lopes Cosméticos conecta o mercado da beleza a marcas e produtos. Distribuição B2B para perfumarias, lojas de cosméticos, salões e negócios do setor com CNPJ.",
  ogImageAlt: "Lopes Cosméticos — distribuidora de cosméticos em Campo Grande, MS",
};

export const contact = {
  /** Endereço completo confirmado. Enquanto null, exibe apenas cidade/UF. */
  address: null as string | null,
  /** WhatsApp comercial (ex.: "(67) 9 0000-0000"). Habilita o botão de WhatsApp. */
  whatsapp: null as string | null,
  whatsappMessage: "Olá! Gostaria de falar com o comercial da Lopes Cosméticos.",
  phone: null as string | null,
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
  eyebrow: "Distribuidora de cosméticos · Campo Grande, MS",
  title: "Tradição que conecta marcas, negócios e oportunidades.",
  /** Trecho do título exibido em destaque (itálico). */
  titleEmphasis: "marcas",
  cardText: "Uma distribuidora consolidada, ao lado de quem vende beleza todos os dias.",
  subtitle:
    "Há mais de 40 anos, a Lopes Cosméticos conecta o mercado da beleza a marcas e produtos para impulsionar negócios.",
  primaryCta: "Sou lojista — Acessar pedidos",
  secondaryCta: "Conheça a Lopes",
  b2bNote: "Atendimento B2B · vendas destinadas a clientes com CNPJ",
  highlights: ["Distribuição de cosméticos", "Atendimento a empresas com CNPJ", "Campo Grande · Mato Grosso do Sul"],
  /** Fotografia opcional para o destaque (ver ImageSlot). */
  image: null as ImageSlot | null,
};

export const about = {
  eyebrow: "Sobre a Lopes",
  title: "Mais de quatro décadas dedicadas ao mercado da beleza.",
  paragraphs: [
    "Há mais de 40 anos, a Lopes Cosméticos atua na distribuição de cosméticos a partir de Campo Grande, Mato Grosso do Sul. Ao longo dessa trajetória, construímos relações duradouras com as marcas com que trabalhamos e com os negócios que levam esses produtos até o consumidor.",
    "Como distribuidora, somos o elo entre a indústria da beleza e o mercado profissional e varejista: reunimos marcas reconhecidas em um portfólio diversificado e oferecemos um atendimento comercial próximo, pensado para quem compra para revender ou para utilizar na rotina do próprio negócio.",
  ],
  commitment:
    "Nosso compromisso é com a parceria comercial: relacionamento transparente, conhecimento do setor e um processo de compra cada vez mais simples para os nossos clientes.",
  chainTitle: "Nosso papel na cadeia da beleza",
  chain: [
    { label: "Marcas e fabricantes", text: "Indústria nacional e internacional de cosméticos." },
    { label: "Lopes Cosméticos", text: "Curadoria de portfólio, distribuição e atendimento comercial." },
    { label: "Lojistas e profissionais", text: "Perfumarias, lojas, salões e negócios do setor com CNPJ." },
  ],
  image: null as ImageSlot | null,
};

export const differentials = {
  eyebrow: "Nossos diferenciais",
  title: "Uma parceria construída sobre experiência e relacionamento.",
  items: [
    {
      icon: "experience",
      title: "Experiência de mercado",
      text: "Mais de quatro décadas acompanhando a evolução do mercado da beleza e as necessidades de quem vende.",
    },
    {
      icon: "portfolio",
      title: "Portfólio diversificado",
      text: "Marcas profissionais e de varejo, de diferentes categorias, reunidas em um único parceiro comercial.",
    },
    {
      icon: "relationship",
      title: "Relacionamento comercial",
      text: "Atendimento próximo e contínuo, com foco em parcerias de longo prazo com cada cliente.",
    },
    {
      icon: "expertise",
      title: "Atendimento especializado",
      text: "Conhecimento do setor de beleza e da rotina de lojas, perfumarias e salões.",
    },
    {
      icon: "orders",
      title: "Facilidade para pedidos",
      text: "Portal de pedidos online para clientes comerciais consultarem o portfólio e realizarem pedidos.",
    },
  ] as const,
};

export const brands = {
  eyebrow: "Nossas marcas",
  title: "Marcas reconhecidas pelo mercado profissional e varejista.",
  intro: "Uma seleção das marcas que fazem parte do portfólio da Lopes Cosméticos.",
  /** Lista inicial do briefing — manter somente marcas confirmadas como comercializadas atualmente. */
  items: [
    { name: "L'Oréal Professionnel" },
    { name: "Schwarzkopf Professional" },
    { name: "Cadiveu" },
    { name: "Davines" },
    { name: "Braé" },
    { name: "DevaCurl" },
    { name: "Forever Liss" },
    { name: "Eico" },
    { name: "Dailus" },
    { name: "Impala" },
    { name: "Giovanna Baby" },
    { name: "Bauny" },
    { name: "Dermachem" },
    { name: "Magic Beauty" },
  ] satisfies Brand[],
  disclaimer:
    "Disponibilidade de marcas e produtos sujeita às políticas comerciais vigentes. Os nomes e marcas citados pertencem aos seus respectivos titulares.",
};

export const segments = {
  eyebrow: "Para lojistas",
  title: "Distribuição para quem faz o mercado da beleza acontecer.",
  intro:
    "Atendemos empresas e profissionais do setor de beleza que compram para revenda ou para uso no próprio negócio.",
  items: [
    {
      icon: "perfumery",
      title: "Perfumarias",
      text: "Variedade de marcas para compor um mix de produtos atrativo e competitivo.",
    },
    {
      icon: "store",
      title: "Lojas de cosméticos",
      text: "Portfólio amplo para abastecer as prateleiras com marcas procuradas pelo consumidor.",
    },
    {
      icon: "salon",
      title: "Salões de beleza",
      text: "Linhas profissionais para o atendimento no salão e para revenda aos clientes.",
    },
    {
      icon: "professional",
      title: "Negócios do setor profissional",
      text: "Outros negócios da beleza que compram com CNPJ, conforme a política comercial.",
    },
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
    "Distribuidora de cosméticos com mais de 40 anos de atuação, conectando marcas a lojistas e profissionais da beleza a partir de Campo Grande, MS.",
};
