-- Separa por ambiente da ADS (homologação × produção) tudo o que depende dele: clientes (o clienteId de
-- homologação não vale na produção), envios (um envio vigente por pedido EM CADA ambiente) e a
-- configuração comercial (códigos validados em um ambiente não valem no outro). Não destrutiva: o que
-- existe hoje foi feito na homologação e é marcado como tal.

ALTER TABLE "ads_customers" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'homologacao';
ALTER TABLE "ads_customers" ALTER COLUMN "environment" DROP DEFAULT;
ALTER TABLE "ads_customers" DROP CONSTRAINT "ads_customers_doc_key";
ALTER TABLE "ads_customers" ADD CONSTRAINT "ads_customers_env_doc_key" UNIQUE ("environment", "cnpj_cpf");
ALTER TABLE "ads_customers" ADD CONSTRAINT "ads_customers_env_check" CHECK ("environment" IN ('homologacao', 'producao'));

ALTER TABLE "ads_order_submissions" ADD CONSTRAINT "ads_order_submissions_env_check" CHECK ("environment" IN ('homologacao', 'producao'));
DROP INDEX "ads_order_submissions_active_key";
CREATE UNIQUE INDEX "ads_order_submissions_active_key" ON "ads_order_submissions" ("order_id", "environment")
  WHERE "status" IN ('SENDING', 'SENT', 'UNKNOWN');

ALTER TABLE "ads_order_attempts" ADD COLUMN "environment" TEXT;
UPDATE "ads_order_attempts" SET "environment" = 'homologacao';

UPDATE "app_settings" SET "key" = 'ads_order_settings:homologacao'
WHERE "key" = 'ads_order_settings'
  AND NOT EXISTS (SELECT 1 FROM "app_settings" WHERE "key" = 'ads_order_settings:homologacao');
