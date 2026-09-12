-- SEO con IA — segunda puerta de revisión: el cliente aprueba (o pide
-- cambios) DESPUÉS del operador y ANTES de que el artículo se publique
-- en su WordPress, en vez de publicarse en directo en el mismo momento
-- en que el operador aprueba. El operador sigue siendo el primer
-- filtro (caza alucinaciones/desalineación), el cliente es el segundo
-- filtro real antes de que salga en vivo en su propio sitio.
--
-- 'approved' desaparece del enum de status: en el flujo anterior era un
-- valor transitorio, sobrescrito en la misma llamada un instante
-- después por 'published'/'publish_failed' — nunca una fila real
-- consultable. Se sustituye por 'pending_client_review', que ahora sí
-- es un estado de reposo real (el cliente puede tardar días en
-- reaccionar).
--
-- No hace falta backfill: no puede existir ninguna fila real con
-- status='approved' hoy (era imposible observarla, por lo de arriba).

ALTER TABLE "SeoContentDraft" ADD COLUMN "client_review_requested_at" TIMESTAMPTZ;
ALTER TABLE "SeoContentDraft" ADD COLUMN "client_reviewed_by" TEXT;
ALTER TABLE "SeoContentDraft" ADD COLUMN "client_reviewed_at" TIMESTAMPTZ;
