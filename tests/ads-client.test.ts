import { describe, expect, it } from "vitest";
import { AdsApiError, getAdsClient } from "@/lib/ads/client";
import { getAdsEnv } from "@/lib/ads/env";
import { mapPrices, mapProducts, mapStocks, parseAdsDate, toDecimalString } from "@/lib/ads/schemas";
import { ConfigError } from "@/lib/env";
import { ADS_CNPJ, ADS_KEY, ADS_UA, defaultData, mockAds, price, product, stock } from "./helpers/ads-mock";

describe("ADS: autenticação e paginação", () => {
  it("envia x-api-key e User-Agent, CNPJ na rota e parâmetros de paginação reais", async () => {
    const data = defaultData();
    data.products = [product(1), product(2), product(3), product(4)];
    const { calls } = mockAds(data);
    const page = await getAdsClient().getPage("produtos", { page: 2 });
    expect(page).toMatchObject({ page: 2, pageSize: 3, total: 4, hasNext: false });
    expect(page.items).toHaveLength(1);
    expect(calls[0]).toMatchObject({ resource: "produtos", page: 2, pageSize: 3 });
    expect(calls[0].headers["x-api-key"]).toBe(ADS_KEY);
    expect(calls[0].headers["user-agent"]).toBe(ADS_UA);
  });

  it("filtra por ids no formato ids=1&ids=2", async () => {
    const data = defaultData();
    data.stocks = [stock(1804, 0), stock(5653, 3)];
    const { calls } = mockAds(data);
    const page = await getAdsClient().getPage("estoques", { page: 1, ids: [1804, 5653] });
    expect(calls[0].ids).toEqual([1804, 5653]);
    expect(page.items).toHaveLength(2);
  });

  it("credencial recusada vira erro 'auth' não transitório, sem expor a chave", async () => {
    mockAds(defaultData());
    process.env.ADS_API_KEY = "chave-errada-SEGREDO";
    const err = await getAdsClient().getPage("produtos", { page: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(AdsApiError);
    expect(err.kind).toBe("auth");
    expect(err.transient).toBe(false);
    expect(err.message).not.toContain("SEGREDO");
  });

  it("classifica 429 (com Retry-After), 5xx, timeout e rede como transitórios", async () => {
    mockAds(defaultData(), [
      { resource: "produtos", page: 1, times: 1, status: 429, retryAfter: "7" },
      { resource: "produtos", page: 2, times: 1, status: 503 },
      { resource: "produtos", page: 3, times: 1, kind: "timeout" },
      { resource: "produtos", page: 4, times: 1, kind: "network" },
    ]);
    const client = getAdsClient();
    const e1 = await client.getPage("produtos", { page: 1 }).catch((e) => e);
    expect([e1.kind, e1.retryAfterMs, e1.transient]).toEqual(["rate_limited", 7000, true]);
    expect((await client.getPage("produtos", { page: 2 }).catch((e) => e)).kind).toBe("server");
    expect((await client.getPage("produtos", { page: 3 }).catch((e) => e)).kind).toBe("timeout");
    expect((await client.getPage("produtos", { page: 4 }).catch((e) => e)).kind).toBe("network");
  });

  it("resposta fora do formato paginado é rejeitada", async () => {
    mockAds(defaultData());
    const err = await getAdsClient().getPage("estoques", { page: 1, ids: [] }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeNull(); // formato válido
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([{ a: 1 }]), { status: 200 })) as typeof fetch;
    const bad = await getAdsClient().getPage("produtos", { page: 1 }).catch((e) => e);
    globalThis.fetch = original;
    expect(bad.kind).toBe("invalid_response");
  });

  it("configuração ausente gera ConfigError citando apenas nomes", () => {
    delete process.env.ADS_API_KEY;
    expect(() => getAdsEnv()).toThrow(ConfigError);
    expect(() => getAdsEnv()).toThrow("ADS_API_KEY");
    process.env.ADS_API_KEY = "x";
    process.env.ADS_CNPJ = "123";
    expect(() => getAdsEnv()).toThrow(/14 dígitos/);
    process.env.ADS_CNPJ = ADS_CNPJ;
    process.env.ADS_API_BASE_URL = "http://ads.inseguro.example";
    expect(() => getAdsEnv()).toThrow(/HTTPS/);
  });
});

describe("ADS: conversão dos dados", () => {
  it("produto real: produtoId como chave, vazios viram null, JSON original preservado", () => {
    const raw = product(1804, { codFab: "H0269721", dun14: "17896014106223", ean13: "7896014106226", descricao: "LOREAL P OXIDANTE CR 950ML 20VOL", imagem: "Z:\\ADS\\FOTOS\\383.jpg", descricaoComplementar: "" });
    const { rows, errors } = mapProducts([raw]);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      ads_product_id: 1804,
      name_original: "LOREAL P OXIDANTE CR 950ML 20VOL",
      manufacturer_code: "H0269721",
      ean: "7896014106226",
      gross_weight: "1.053",
      width: "0",
      erp_image_ref: "Z:\\ADS\\FOTOS\\383.jpg",
      b2b: true,
      inactive: false,
    });
    expect(rows[0].raw_payload).toEqual(raw);
  });

  it("item inválido vira erro (sem inventar valores); estoque ausente não vira zero", () => {
    const p = mapProducts([{ descricao: "sem id" }]);
    expect(p.rows).toHaveLength(0);
    expect(p.errors[0].code).toBe("INVALID_ITEM");
    const s = mapStocks([{ filialId: "01", produtoId: 10 }]);
    expect(s.rows).toHaveLength(0);
    expect(s.errors[0]).toMatchObject({ externalProductId: 10, code: "INVALID_ITEM" });
  });

  it("valores monetários viram decimais exatos; datas sem fuso = horário de Brasília", () => {
    const { rows } = mapPrices([price(1804, "F", 88.2)]);
    expect(rows[0]).toMatchObject({ price: "88.2", discount: "10", ceiling_value: "72.1467", pvs: "83.25", inactive: false });
    expect(toDecimalString(1e-7)).toBe("0.0000001");
    expect(toDecimalString(null)).toBeNull();
    expect(parseAdsDate("2026-10-22T00:00:00")).toBe("2026-10-22T03:00:00.000Z");
    expect(parseAdsDate("")).toBeNull();
  });
});
