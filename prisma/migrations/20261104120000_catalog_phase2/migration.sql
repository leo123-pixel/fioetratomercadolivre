-- CreateTable
CREATE TABLE "ads_suppliers" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "trade_name" TEXT,
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads_divisions" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_divisions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "ads_product_id" INTEGER NOT NULL,
    "name_original" TEXT NOT NULL,
    "name_custom" TEXT,
    "manufacturer_code" TEXT,
    "ean" TEXT,
    "dun14" TEXT,
    "ncm" TEXT,
    "supplier_id" INTEGER,
    "division_id" TEXT,
    "presentation" TEXT,
    "unit" TEXT,
    "package_qty" INTEGER,
    "gross_weight" DECIMAL(12,4),
    "net_weight" DECIMAL(12,4),
    "width" DECIMAL(12,4),
    "height" DECIMAL(12,4),
    "length" DECIMAL(12,4),
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "b2b" BOOLEAN,
    "erp_image_ref" TEXT,
    "ads_updated_at" TIMESTAMPTZ(3),
    "raw_payload" JSONB NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "custom_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tables" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "base" TEXT,
    "expense" DECIMAL(12,4),
    "commission" DECIMAL(12,4),
    "profit" DECIMAL(12,4),
    "freight" DECIMAL(12,4),
    "markup" DECIMAL(12,4),
    "is_normal" BOOLEAN NOT NULL DEFAULT false,
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "ads_updated_at" TIMESTAMPTZ(3),
    "raw_payload" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" BIGSERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "ads_product_id" INTEGER NOT NULL,
    "branch_id" TEXT NOT NULL,
    "price_table_code" TEXT NOT NULL,
    "price" DECIMAL(14,4),
    "discount" DECIMAL(12,4),
    "commission" DECIMAL(12,4),
    "ceiling_value" DECIMAL(14,4),
    "pvs" DECIMAL(14,4),
    "minimum_quantity" DECIMAL(14,3),
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "promotion" BOOLEAN NOT NULL DEFAULT false,
    "ads_updated_at" TIMESTAMPTZ(3),
    "raw_payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stocks" (
    "id" BIGSERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "ads_product_id" INTEGER NOT NULL,
    "branch_id" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "last_sale_at" TIMESTAMPTZ(3),
    "raw_payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "public_url" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "original_filename" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_drafts" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "selected_price_table" TEXT,
    "selected_branch_id" TEXT,
    "reference_price" DECIMAL(14,4),
    "listing_price" DECIMAL(14,2),
    "listing_quantity" INTEGER,
    "marketplace_category_id" TEXT,
    "marketplace_attributes" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "params" JSONB NOT NULL DEFAULT '{}',
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "total" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "error_summary" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job_errors" (
    "id" BIGSERIAL NOT NULL,
    "import_job_id" UUID NOT NULL,
    "external_product_id" INTEGER,
    "page" INTEGER,
    "error_code" TEXT NOT NULL,
    "error_message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_leases" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lease_until" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_leases_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_ads_product_id_key" ON "products"("ads_product_id");

-- CreateIndex
CREATE INDEX "products_supplier_id_idx" ON "products"("supplier_id");

-- CreateIndex
CREATE INDEX "products_division_id_idx" ON "products"("division_id");

-- CreateIndex
CREATE INDEX "products_ean_idx" ON "products"("ean");

-- CreateIndex
CREATE INDEX "products_manufacturer_code_idx" ON "products"("manufacturer_code");

-- CreateIndex
CREATE UNIQUE INDEX "price_tables_code_key" ON "price_tables"("code");

-- CreateIndex
CREATE INDEX "product_prices_product_id_price_table_code_idx" ON "product_prices"("product_id", "price_table_code");

-- CreateIndex
CREATE INDEX "product_prices_price_table_code_idx" ON "product_prices"("price_table_code");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_ads_product_id_branch_id_price_table_code_key" ON "product_prices"("ads_product_id", "branch_id", "price_table_code");

-- CreateIndex
CREATE INDEX "product_stocks_product_id_idx" ON "product_stocks"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_stocks_ads_product_id_branch_id_key" ON "product_stocks"("ads_product_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_storage_path_key" ON "product_images"("storage_path");

-- CreateIndex
CREATE INDEX "product_images_product_id_position_idx" ON "product_images"("product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "listing_drafts_product_id_key" ON "listing_drafts"("product_id");

-- CreateIndex
CREATE INDEX "listing_drafts_status_idx" ON "listing_drafts"("status");

-- CreateIndex
CREATE INDEX "import_jobs_status_created_at_idx" ON "import_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "import_jobs_created_at_idx" ON "import_jobs"("created_at");

-- CreateIndex
CREATE INDEX "import_job_errors_import_job_id_created_at_idx" ON "import_job_errors"("import_job_id", "created_at");

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_errors" ADD CONSTRAINT "import_job_errors_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints e índices não representáveis no schema.prisma
-- ---------------------------------------------------------------------------

-- Situações e tipos válidos (texto + CHECK em vez de ENUM para facilitar evolução sem ALTER TYPE).
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_type_check"
  CHECK ("type" IN ('PRODUCTS', 'PRICE_TABLES', 'PRICES', 'STOCKS'));
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_status_check"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELED'));
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_counters_check"
  CHECK ("processed" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "unchanged" >= 0 AND "failed" >= 0 AND "attempts" >= 0);

-- Controle de concorrência: no máximo uma importação ativa por tipo.
CREATE UNIQUE INDEX "import_jobs_one_active_per_type"
  ON "import_jobs" ("type") WHERE "status" IN ('PENDING', 'RUNNING');

ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_status_check"
  CHECK ("status" IN ('DRAFT', 'READY', 'ARCHIVED'));
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_price_check"
  CHECK ("listing_price" IS NULL OR "listing_price" > 0);
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_quantity_check"
  CHECK ("listing_quantity" IS NULL OR "listing_quantity" >= 0);
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_title_check"
  CHECK ("title" IS NULL OR char_length("title") <= 120);

-- Uma única imagem principal por produto.
CREATE UNIQUE INDEX "product_images_one_primary"
  ON "product_images" ("product_id") WHERE "is_primary";
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_size_check"
  CHECK ("size_bytes" > 0 AND "position" >= 0);

