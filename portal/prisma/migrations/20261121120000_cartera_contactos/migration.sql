-- Cartera PR 5: la purga diaria de contactos de más de 24 meses.
ALTER TABLE "cartera_site" ADD COLUMN "enquiries_purged_at" TIMESTAMP(3);
