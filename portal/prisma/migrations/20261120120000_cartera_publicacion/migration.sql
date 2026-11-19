-- Cartera, PR 4: publicación desde el portal (docs/fase1-cartera.md, «Publicar sin que nadie lo lance»).
-- Columnas nuevas, todas opcionales: no hay que rellenar nada.
ALTER TABLE "cartera_site" ADD COLUMN "last_change_at" TIMESTAMP(3);

ALTER TABLE "cartera_build" ADD COLUMN "stage" TEXT,
ADD COLUMN "release" TEXT,
ADD COLUMN "commit_sha" TEXT,
ADD COLUMN "last_notice_at" TIMESTAMP(3);

-- Emparejar el aviso por el enlace de la ejecución cuando no trae buildId.
CREATE INDEX "cartera_build_site_id_run_url_idx" ON "cartera_build"("site_id", "run_url");
