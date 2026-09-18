-- Fase A de Prospección — el contexto del negocio del cliente, con el que
-- se le sugieren rubros y zonas en vez de dejarle dos campos en blanco.
-- Ver el comentario del modelo ProspectingCampaign en schema.prisma.

ALTER TABLE "ProspectingCampaign"
  ADD COLUMN "client_website" TEXT,
  ADD COLUMN "business_description" TEXT,
  ADD COLUMN "ideal_customer" TEXT,
  ADD COLUMN "exclusions" TEXT;
