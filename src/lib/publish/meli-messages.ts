/**
 * Tradução para português das mensagens de validação/publicação do Mercado Livre (POST /items/validate e
 * POST /items). O ML responde em inglês; aqui cada causa conhecida vira um texto claro em português e, quando
 * a causa aponta um atributo, o campo correspondente na tela (`attr:<ID>`). Mensagens desconhecidas continuam
 * aparecendo com o texto original do ML, para nada ser escondido.
 */

export interface TranslatedCause {
  message: string;
  field?: string;
}

/** Nome do atributo em português, a partir dos atributos da categoria (quando disponíveis). */
export type AttributeNameLookup = (id: string) => string | undefined;

function attrLabel(id: string, names?: AttributeNameLookup): string {
  const name = names?.(id);
  return name && name !== id ? `${name} (${id})` : id;
}

function listLabel(raw: string, names?: AttributeNameLookup): string {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.replace(/[[\]"']/g, "").trim())
    .filter(Boolean)
    .map((id) => attrLabel(id, names))
    .join(", ");
}

type Rule = (code: string, msg: string, names?: AttributeNameLookup) => TranslatedCause | null;

const RULES: Rule[] = [
  // Atributos
  (_c, m, n) => {
    const r = m.match(/value name of attribute (\w+) was not provided and couldn'?t be resolved/i);
    return r
      ? { message: `O valor de ${attrLabel(r[1], n)} não foi reconhecido pelo Mercado Livre. Apague e digite o valor novamente no campo.`, field: `attr:${r[1]}` }
      : null;
  },
  (_c, m, n) => {
    const r = m.match(/the attributes? \[?([^\]]+?)\]? (?:are|is) required/i);
    if (!r) return null;
    const ids = r[1].split(/[,\s]+/).map((s) => s.replace(/[[\]"']/g, "")).filter(Boolean);
    return { message: `Atributos obrigatórios não preenchidos: ${listLabel(r[1], n)}.`, field: ids.length === 1 ? `attr:${ids[0]}` : undefined };
  },
  (c, m, n) => {
    if (!/missing_conditional_required|conditional/i.test(c)) return null;
    const r = m.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
    return r
      ? { message: `A categoria exige o atributo ${attrLabel(r[1], n)} para os valores informados.`, field: `attr:${r[1]}` }
      : { message: "A categoria exige atributos adicionais para os valores informados." };
  },
  (_c, m, n) => {
    const r = m.match(/attribute:? \[?(\w+)\]? (?:has an invalid|is not valid|with invalid|has invalid)/i) ?? m.match(/invalid (?:value|values) for attribute:? \[?(\w+)\]?/i);
    return r ? { message: `Valor inválido no atributo ${attrLabel(r[1], n)}.`, field: `attr:${r[1]}` } : null;
  },
  (_c, m, n) => {
    const r = m.match(/attribute:? \[?(\w+)\]? .*(?:length|too long|max(?:imum)? length)/i);
    return r ? { message: `O valor do atributo ${attrLabel(r[1], n)} é longo demais.`, field: `attr:${r[1]}` } : null;
  },
  (c, m) =>
    /product_identifier|gtin/i.test(c) || /product identifier|gtin/i.test(m)
      ? { message: "Código de barras (GTIN/EAN) inválido ou não aceito para esta categoria. Confira o código ou informe o motivo da ausência.", field: "attr:GTIN" }
      : null,

  // Envio
  (c, m) =>
    /lost_me1/i.test(c) || /has not mode me1/i.test(m)
      ? { message: "A conta não usa o Mercado Envios 1 (ME1); o anúncio será criado com o modo de envio disponível na conta." }
      : null,
  (c) =>
    /mandatory_free_shipping/i.test(c)
      ? { message: "Frete grátis é obrigatório para este anúncio (pela faixa de preço ou categoria); o Mercado Livre vai aplicá-lo automaticamente." }
      : null,
  (c) => (/shipping\.mode/i.test(c) ? { message: "Modo de envio não aceito para esta conta ou categoria." } : null),
  (c) => (/shipping/i.test(c) && /dimension/i.test(c) ? { message: "Dimensões/peso do pacote ausentes ou inválidos para o envio." } : null),

  // Título, descrição, categoria
  (c, m) => (/title/i.test(c) && /length|long|max/i.test(c + m) ? { message: "O título é longo demais para esta categoria.", field: "title" } : null),
  (c) => (/title/i.test(c) ? { message: "Título inválido para o Mercado Livre.", field: "title" } : null),
  (c) => (/family_name/i.test(c) ? { message: "Nome da família (family_name) inválido.", field: "familyName" } : null),
  (c) => (/description/i.test(c) ? { message: "Descrição inválida para o Mercado Livre.", field: "description" } : null),
  (c) => (/category/i.test(c) ? { message: "Categoria inválida ou que não aceita anúncios.", field: "category" } : null),

  // Comercial
  (c, m) => {
    if (!/price/i.test(c)) return null;
    const r = m.match(/(?:minimum|min)\D*([\d.,]+)/i);
    return { message: r ? `Preço abaixo do mínimo permitido para esta categoria (mínimo R$ ${r[1]}).` : "Preço inválido para esta categoria.", field: "listingPrice" };
  },
  (c) => (/available_quantity|quantity/i.test(c) ? { message: "Quantidade disponível inválida.", field: "listingQuantity" } : null),
  (c) => (/listing_type/i.test(c) ? { message: "Tipo de anúncio não disponível para esta conta ou categoria.", field: "listingTypeId" } : null),
  (c) => (/condition/i.test(c) ? { message: "Condição do item (novo/usado) não aceita nesta categoria.", field: "itemCondition" } : null),
  (c) => (/buying_mode/i.test(c) ? { message: "Modo de compra não aceito nesta categoria." } : null),
  (c) => (/currency/i.test(c) ? { message: "Moeda não aceita (use BRL)." } : null),

  // Imagens
  (c, m) => (/picture/i.test(c) && /min|size|resolution|pixel/i.test(c + m) ? { message: "Imagem pequena demais ou em resolução não aceita (mínimo 500 px)." } : null),
  (c) => (/picture/i.test(c) ? { message: "Problema nas imagens do anúncio (faltando, inválidas ou não acessíveis pelo Mercado Livre)." } : null),

  // Conta / genéricos
  (c, m) => (/seller|user/i.test(c) && /restrict|block|not allowed|forbidden/i.test(c + m) ? { message: "A conta do Mercado Livre está com restrição para publicar. Verifique o painel do vendedor." } : null),
];

/** Traduz uma causa do Mercado Livre. `code` é o código bruto da causa (ex.: "item.attribute.invalid"). */
export function translateMeliCause(code: string | undefined, message: string | undefined, names?: AttributeNameLookup): TranslatedCause {
  const c = code ?? "";
  const m = message ?? "";
  for (const rule of RULES) {
    const t = rule(c, m, names);
    if (t) return t;
  }
  return { message: m ? `Mensagem do Mercado Livre: ${m}` : "Erro informado pelo Mercado Livre." };
}
