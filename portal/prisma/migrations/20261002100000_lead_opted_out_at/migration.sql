-- La marca explícita de oposición del prospecto (ver Lead.optedOutAt).
ALTER TABLE "Lead" ADD COLUMN "opted_out_at" TIMESTAMP(3);

-- Relleno: hasta hoy la oposición se deducía de dos formas.
--   1. La baja por WhatsApp: markProspectReplied dejaba 'descartado' con
--      replied_at. Se opuso cuando respondió.
UPDATE "Lead"
   SET "opted_out_at" = "replied_at"
 WHERE "status" = 'descartado'
   AND "replied_at" IS NOT NULL
   AND "opted_out_at" IS NULL;

--   2. El otro local de quien se opuso: el bloqueo por teléfono lo
--      descartaba con este error. Es la misma persona.
UPDATE "Lead"
   SET "opted_out_at" = COALESCE("discarded_at", "updated_at")
 WHERE "status" = 'descartado'
   AND "auto_contact_error" = 'mismo_telefono_rechazo_el_contacto'
   AND "opted_out_at" IS NULL;
