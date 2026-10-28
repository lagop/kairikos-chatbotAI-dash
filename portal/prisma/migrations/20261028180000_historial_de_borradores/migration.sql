-- 28/10/2026 — historial de los borradores de prospecto (retoque a mano y
-- regeneración). Ver ProspectingWebDraftVersion en schema.prisma.
CREATE TABLE "ProspectingWebDraftVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draft_id" UUID NOT NULL,
    "accion" TEXT NOT NULL,
    "nota" TEXT,
    "actor_id" TEXT NOT NULL,
    "copy" JSONB NOT NULL,
    "content" JSONB,
    "template_id" UUID,
    "theme_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectingWebDraftVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProspectingWebDraftVersion_draft_id_created_at_idx" ON "ProspectingWebDraftVersion"("draft_id", "created_at");

ALTER TABLE "ProspectingWebDraftVersion" ADD CONSTRAINT "ProspectingWebDraftVersion_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ProspectingWebDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
