-- Permite nova publicação de um produto cujo anúncio anterior foi encerrado ou excluído no
-- Mercado Livre. Não destrutiva: só troca dois índices únicos por índices únicos parciais.
-- Continua valendo no máximo UM anúncio vigente (status diferente de closed/deleted) por
-- rascunho e por produto+conta; os anúncios encerrados ficam guardados como histórico.

DROP INDEX IF EXISTS "marketplace_listings_listing_draft_id_key";
DROP INDEX IF EXISTS "marketplace_listings_product_id_marketplace_account_id_key";

CREATE UNIQUE INDEX "marketplace_listings_current_per_draft"
  ON "marketplace_listings" ("listing_draft_id")
  WHERE "status" NOT IN ('closed', 'deleted');

CREATE UNIQUE INDEX "marketplace_listings_current_per_product_account"
  ON "marketplace_listings" ("product_id", "marketplace_account_id")
  WHERE "status" NOT IN ('closed', 'deleted');

CREATE INDEX "marketplace_listings_listing_draft_id_idx" ON "marketplace_listings" ("listing_draft_id");
CREATE INDEX "marketplace_listings_product_id_idx" ON "marketplace_listings" ("product_id");
