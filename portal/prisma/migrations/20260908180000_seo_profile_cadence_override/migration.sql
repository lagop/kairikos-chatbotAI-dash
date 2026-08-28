-- SEO con IA — override por cliente de SeoSettings.content_generation_min_interval_days.
-- NULL = usa el valor global. Ver el comentario del campo en schema.prisma.

ALTER TABLE "SeoProfile" ADD COLUMN "content_generation_min_interval_days_override" INTEGER;
