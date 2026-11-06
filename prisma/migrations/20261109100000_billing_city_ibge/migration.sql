-- Município (código IBGE) do endereço do comprador, resolvido uma vez e guardado no pedido.
-- source: NOME (nome oficial), CEP (fontes de CEP), ADS (cadastro de cidades da ADS), MANUAL (escolhido pelo operador).
ALTER TABLE "marketplace_order_billing" ADD COLUMN "city_ibge" TEXT;
ALTER TABLE "marketplace_order_billing" ADD COLUMN "city_ibge_name" TEXT;
ALTER TABLE "marketplace_order_billing" ADD COLUMN "city_ibge_source" TEXT;
ALTER TABLE "marketplace_order_billing" ADD CONSTRAINT "marketplace_order_billing_city_ibge_check"
  CHECK ("city_ibge" IS NULL OR ("city_ibge" ~ '^[0-9]{7}$' AND "city_ibge_source" IN ('NOME', 'CEP', 'ADS', 'MANUAL')));
