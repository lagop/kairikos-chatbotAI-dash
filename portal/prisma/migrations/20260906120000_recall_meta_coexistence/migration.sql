-- WP-XX — Fase 8 de "Recuperación de llamadas perdidas + reseñas":
-- Coexistence.
--
-- Both columns additive and nullable-safe (isCoexistence defaults false,
-- platformType defaults NULL/"unknown") — every MetaChannelConnection
-- row that exists today was made through the plain Cloud-API-only flow,
-- so false/unknown is the honest default rather than a guess.

ALTER TABLE "MetaChannelConnection" ADD COLUMN "is_coexistence" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MetaChannelConnection" ADD COLUMN "platform_type" TEXT;
