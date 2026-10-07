-- CreateEnum
CREATE TYPE "LinkStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "pending_code_hash" TEXT;

-- CreateTable
CREATE TABLE "school" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrolment" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "academic_year" TEXT NOT NULL,
    "class_name" TEXT NOT NULL,

    CONSTRAINT "enrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child_code" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "redeemed_at" TIMESTAMP(3),
    "redeemed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_child_link" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "status" "LinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parent_child_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_invite" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardian_invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "customer_id" UUID,
    "child_id" UUID,
    "ip" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "child_school_id_idx" ON "child"("school_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolment_child_id_academic_year_key" ON "enrolment"("child_id", "academic_year");

-- CreateIndex
CREATE UNIQUE INDEX "child_code_code_hash_key" ON "child_code"("code_hash");

-- CreateIndex
CREATE INDEX "child_code_child_id_idx" ON "child_code"("child_id");

-- CreateIndex
CREATE INDEX "parent_child_link_child_id_idx" ON "parent_child_link"("child_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_child_link_customer_id_child_id_key" ON "parent_child_link"("customer_id", "child_id");

-- CreateIndex
CREATE UNIQUE INDEX "guardian_invite_token_hash_key" ON "guardian_invite"("token_hash");

-- CreateIndex
CREATE INDEX "guardian_invite_child_id_idx" ON "guardian_invite"("child_id");

-- CreateIndex
CREATE INDEX "audit_log_customer_id_action_created_at_idx" ON "audit_log"("customer_id", "action", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_child_id_idx" ON "audit_log"("child_id");

-- AddForeignKey
ALTER TABLE "child" ADD CONSTRAINT "child_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_code" ADD CONSTRAINT "child_code_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_child_link" ADD CONSTRAINT "parent_child_link_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_child_link" ADD CONSTRAINT "parent_child_link_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_invite" ADD CONSTRAINT "guardian_invite_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
