-- AlterTable
ALTER TABLE "product_images" ADD COLUMN     "ml_picture_at" TIMESTAMPTZ(3),
ADD COLUMN     "ml_picture_id" TEXT;

-- AlterTable
ALTER TABLE "listing_drafts" ADD COLUMN     "catalog_listing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "catalog_product_id" TEXT,
ADD COLUMN     "category_name" TEXT,
ADD COLUMN     "family_name" TEXT,
ADD COLUMN     "item_condition" TEXT DEFAULT 'new',
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "listing_type_id" TEXT,
ADD COLUMN     "sale_terms" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "validated_at" TIMESTAMPTZ(3),
ADD COLUMN     "validated_fingerprint" TEXT,
ADD COLUMN     "validated_version" INTEGER,
ADD COLUMN     "validation_result" JSONB,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "ads_product_id" INTEGER NOT NULL,
    "listing_draft_id" INTEGER NOT NULL,
    "marketplace_account_id" TEXT NOT NULL,
    "marketplace_item_id" TEXT NOT NULL,
    "user_product_id" TEXT,
    "family_id" TEXT,
    "category_id" TEXT NOT NULL,
    "listing_type" TEXT,
    "price" DECIMAL(14,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "permalink" TEXT,
    "description_status" TEXT,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_publication_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "listing_draft_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "account_id" TEXT NOT NULL,
    "batch_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requested_by" TEXT NOT NULL,
    "draft_version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "reconcile_count" INTEGER NOT NULL DEFAULT 0,
    "create_sent_at" TIMESTAMPTZ(3),
    "next_run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "marketplace_item_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_publication_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_publication_attempts" (
    "id" BIGSERIAL NOT NULL,
    "publication_job_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "sanitized_request" JSONB,
    "sanitized_response" JSONB,
    "http_status" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_publication_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_category_cache" (
    "id" SERIAL NOT NULL,
    "category_id" TEXT NOT NULL,
    "category_name" TEXT,
    "category_json" JSONB,
    "attributes_json" JSONB,
    "technical_specs_json" JSONB,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marketplace_category_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listing_events" (
    "id" BIGSERIAL NOT NULL,
    "listing_draft_id" INTEGER NOT NULL,
    "listing_id" INTEGER,
    "job_id" UUID,
    "event_type" TEXT NOT NULL,
    "previous_status" TEXT,
    "new_status" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_listing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_listing_draft_id_key" ON "marketplace_listings"("listing_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_marketplace_item_id_key" ON "marketplace_listings"("marketplace_item_id");

-- CreateIndex
CREATE INDEX "marketplace_listings_ads_product_id_idx" ON "marketplace_listings"("ads_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_product_id_marketplace_account_id_key" ON "marketplace_listings"("product_id", "marketplace_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_publication_jobs_idempotency_key_key" ON "marketplace_publication_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "marketplace_publication_jobs_status_next_run_at_idx" ON "marketplace_publication_jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "marketplace_publication_jobs_batch_id_idx" ON "marketplace_publication_jobs"("batch_id");

-- CreateIndex
CREATE INDEX "marketplace_publication_attempts_publication_job_id_created_idx" ON "marketplace_publication_attempts"("publication_job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_category_cache_category_id_key" ON "marketplace_category_cache"("category_id");

-- CreateIndex
CREATE INDEX "marketplace_listing_events_listing_draft_id_created_at_idx" ON "marketplace_listing_events"("listing_draft_id", "created_at");

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_listing_draft_id_fkey" FOREIGN KEY ("listing_draft_id") REFERENCES "listing_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_publication_jobs" ADD CONSTRAINT "marketplace_publication_jobs_listing_draft_id_fkey" FOREIGN KEY ("listing_draft_id") REFERENCES "listing_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_publication_attempts" ADD CONSTRAINT "marketplace_publication_attempts_publication_job_id_fkey" FOREIGN KEY ("publication_job_id") REFERENCES "marketplace_publication_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listing_events" ADD CONSTRAINT "marketplace_listing_events_listing_draft_id_fkey" FOREIGN KEY ("listing_draft_id") REFERENCES "listing_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listing_events" ADD CONSTRAINT "marketplace_listing_events_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Fase 3: constraints e índices não representáveis no schema.prisma
-- ---------------------------------------------------------------------------

-- Novos estados do rascunho (rascunhos existentes DRAFT/READY/ARCHIVED continuam válidos).
ALTER TABLE "listing_drafts" DROP CONSTRAINT IF EXISTS "listing_drafts_status_check";
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_status_check"
  CHECK ("status" IN ('DRAFT','INCOMPLETE','READY','VALIDATING','VALIDATED','PUBLISHING','PUBLISHED','FAILED','UNKNOWN','ARCHIVED'));
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_condition_check"
  CHECK ("item_condition" IS NULL OR "item_condition" IN ('new','used','not_specified'));
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_version_check" CHECK ("version" >= 1);

ALTER TABLE "marketplace_publication_jobs" ADD CONSTRAINT "publication_jobs_status_check"
  CHECK ("status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','UNKNOWN','CANCELED'));
ALTER TABLE "marketplace_publication_jobs" ADD CONSTRAINT "publication_jobs_counters_check"
  CHECK ("attempt_count" >= 0 AND "reconcile_count" >= 0 AND "draft_version" >= 1);

-- Proteção contra publicações simultâneas: no máximo um job ativo (ou com resultado incerto) por rascunho.
CREATE UNIQUE INDEX "publication_jobs_one_active_per_draft"
  ON "marketplace_publication_jobs" ("listing_draft_id") WHERE "status" IN ('QUEUED','RUNNING','UNKNOWN');

ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_values_check"
  CHECK ("price" > 0 AND "quantity" >= 0);
