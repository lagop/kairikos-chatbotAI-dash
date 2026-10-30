-- 30/10/2026 — borradores de kairikos.com entregados en menos de 24 horas
-- (lib/public-draft-delivery.ts). La petición se guarda al momento, sin
-- borrador (copy y model null hasta generarlo), y el enlace se abre al
-- enviarlo (sent_at).
ALTER TABLE "PublicDraftRequest" ALTER COLUMN "copy" DROP NOT NULL;
ALTER TABLE "PublicDraftRequest" ALTER COLUMN "model" DROP NOT NULL;
ALTER TABLE "PublicDraftRequest" ADD COLUMN "phone" TEXT;
ALTER TABLE "PublicDraftRequest" ADD COLUMN "sent_at" TIMESTAMP(3);
ALTER TABLE "PublicDraftRequest" ADD COLUMN "generation_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PublicDraftRequest" ADD COLUMN "delivery_error" TEXT;
CREATE INDEX "PublicDraftRequest_sent_at_idx" ON "PublicDraftRequest"("sent_at");

-- Las que ya existían se enseñaron al momento: ya están enviadas.
UPDATE "PublicDraftRequest" SET "sent_at" = "created_at" WHERE "sent_at" IS NULL;
