-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPERADMIN', 'STAFF');

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "staff_id" UUID;

-- CreateTable
CREATE TABLE "staff_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'STAFF',
    "password_hash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "invite_token_hash" TEXT,
    "invite_expires_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_session" (
    "token_hash" TEXT NOT NULL,
    "staff_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_session_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "staff_login_challenge" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_login_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_email_key" ON "staff_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_invite_token_hash_key" ON "staff_user"("invite_token_hash");

-- CreateIndex
CREATE INDEX "staff_session_staff_id_idx" ON "staff_session"("staff_id");

-- CreateIndex
CREATE INDEX "staff_login_challenge_staff_id_idx" ON "staff_login_challenge"("staff_id");

-- AddForeignKey
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_login_challenge" ADD CONSTRAINT "staff_login_challenge_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

