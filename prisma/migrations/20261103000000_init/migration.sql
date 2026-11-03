-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MeliConnectionStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "binding_hash" TEXT NOT NULL,
    "code_verifier_enc" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meli_connections" (
    "id" TEXT NOT NULL,
    "meli_user_id" TEXT NOT NULL,
    "nickname" TEXT,
    "site_id" TEXT,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "status" "MeliConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "refresh_lock_id" TEXT,
    "refresh_lock_until" TIMESTAMP(3),
    "last_connected_at" TIMESTAMP(3),
    "last_refreshed_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meli_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_login_throttle" (
    "key_hash" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_login_throttle_pkey" PRIMARY KEY ("key_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "meli_connections_meli_user_id_key" ON "meli_connections"("meli_user_id");

