-- SEO con IA — SeoSettings, singleton de configuracion global del
-- producto (empieza con la cadencia de generacion de contenido). Ver el
-- comentario del modelo en schema.prisma.

CREATE TABLE "SeoSettings" (
    "id" UUID NOT NULL,
    "content_generation_min_interval_days" INTEGER NOT NULL DEFAULT 3,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "SeoSettings_pkey" PRIMARY KEY ("id")
);
