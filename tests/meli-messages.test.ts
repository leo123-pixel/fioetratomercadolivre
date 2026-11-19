import { describe, expect, it } from "vitest";
import { translateMeliCause } from "@/lib/publish/meli-messages";

const names = (id: string) => ({ MODEL: "Modelo", MANUAL_TITLE: "Título do manual", BRAND: "Marca" })[id];

describe("tradução das mensagens do Mercado Livre", () => {
  it("valor de atributo não reconhecido aponta o campo do atributo, com o nome em português", () => {
    const t = translateMeliCause("item.attribute.invalid", "Value name of attribute MANUAL_TITLE was not provided and couldn't be resolved from attributes database.", names);
    expect(t).toEqual({ message: expect.stringContaining("Título do manual (MANUAL_TITLE) não foi reconhecido"), field: "attr:MANUAL_TITLE" });
    expect(translateMeliCause("item.attribute.invalid", "Value name of attribute MODEL was not provided and couldn't be resolved from attributes database.").field).toBe("attr:MODEL");
  });

  it("avisos de frete e atributos obrigatórios", () => {
    expect(translateMeliCause("shipping.lost_me1_by_user", "User has not mode me1").message).toMatch(/Mercado Envios 1/);
    expect(translateMeliCause("item.shipping.mandatory_free_shipping", "Free shipping is mandatory").message).toMatch(/Frete grátis é obrigatório/);
    expect(translateMeliCause("item.attributes.missing_required", "The attributes [BRAND, MODEL] are required for category MLB1234.", names).message).toBe(
      "Atributos obrigatórios não preenchidos: Marca (BRAND), Modelo (MODEL).",
    );
  });

  it("mensagem desconhecida continua visível com o texto original", () => {
    expect(translateMeliCause("item.something.new", "Something new happened").message).toBe("Mensagem do Mercado Livre: Something new happened");
  });
});
