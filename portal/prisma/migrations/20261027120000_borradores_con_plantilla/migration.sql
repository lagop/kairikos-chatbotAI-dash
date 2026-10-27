-- Webs con IA, entrega 3 (27/10/2026): borradores con plantilla de diseño y
-- contenido v2. Nullable: sin plantilla aprobada para su sector, el borrador
-- sigue saliendo de "copy" como siempre.
ALTER TABLE "ProspectingWebDraft" ADD COLUMN "content" JSONB;
ALTER TABLE "ProspectingWebDraft" ADD COLUMN "template_id" UUID;
ALTER TABLE "PublicDraftRequest" ADD COLUMN "content" JSONB;
ALTER TABLE "PublicDraftRequest" ADD COLUMN "template_id" UUID;
