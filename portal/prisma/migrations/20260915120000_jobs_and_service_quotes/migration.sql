-- Fase 2 — trabajos realizados y presupuestos emitidos.
--
-- Sin backfill: no hay nada que rellenar. Este sistema nunca ha registrado
-- un trabajo ni un presupuesto, y no se pueden deducir de las llamadas —
-- una llamada dice que alguien preguntó, no que se le hiciera el trabajo
-- ni por cuánto. Ambas tablas nacen vacías y se llenan desde la captura
-- por voz.

CREATE TABLE IF NOT EXISTS "Job" (
  "id"                    UUID         NOT NULL,
  "client_id"             TEXT         NOT NULL,
  "tenant_id"             UUID,
  "contact_id"            UUID,
  "completed_at"          TIMESTAMP(3) NOT NULL,
  "service_type"          TEXT,
  "equipment"             JSONB,
  "amount"                DECIMAL(12,2),
  "currency"              TEXT         NOT NULL DEFAULT 'EUR',
  "next_service_due_at"   DATE,
  "capture_method"        TEXT         NOT NULL,
  "raw_capture"           TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ServiceQuote" (
  "id"                     UUID         NOT NULL,
  "client_id"              TEXT         NOT NULL,
  "tenant_id"              UUID,
  "contact_id"             UUID,
  "issued_at"              TIMESTAMP(3) NOT NULL,
  "amount"                 DECIMAL(12,2),
  "currency"               TEXT         NOT NULL DEFAULT 'EUR',
  "status"                 TEXT         NOT NULL DEFAULT 'open',
  "last_followed_up_at"    TIMESTAMP(3),
  "description"            TEXT,
  "capture_method"         TEXT         NOT NULL,
  "raw_capture"            TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ServiceQuote_pkey" PRIMARY KEY ("id")
);

-- El contacto se desengancha (SET NULL), no arrastra. Borrar a una persona
-- por retención no puede borrar el importe que pagó: el registro contable
-- sobrevive al dato personal, que es lo que hace compatible cumplir con un
-- borrado y seguir cuadrando las cuentas del año.
ALTER TABLE "Job"
  ADD CONSTRAINT "Job_client_id_fkey"  FOREIGN KEY ("client_id")  REFERENCES "ChatbotClient"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "Job_tenant_id_fkey"  FOREIGN KEY ("tenant_id")  REFERENCES "Tenant"("id")        ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Job_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "Contact"("id")       ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ServiceQuote"
  ADD CONSTRAINT "ServiceQuote_client_id_fkey"  FOREIGN KEY ("client_id")  REFERENCES "ChatbotClient"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "ServiceQuote_tenant_id_fkey"  FOREIGN KEY ("tenant_id")  REFERENCES "Tenant"("id")        ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ServiceQuote_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "Contact"("id")       ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Job_client_id_completed_at_idx"        ON "Job" ("client_id", "completed_at");
CREATE INDEX IF NOT EXISTS "Job_contact_id_idx"                    ON "Job" ("contact_id");
-- "Qué revisiones tocan en marzo": el disparador de aniversario.
CREATE INDEX IF NOT EXISTS "Job_client_id_next_service_due_at_idx" ON "Job" ("client_id", "next_service_due_at");
CREATE INDEX IF NOT EXISTS "Job_tenant_id_idx"                     ON "Job" ("tenant_id");

-- "Los presupuestos abiertos de este cliente, por antigüedad": el
-- disparador open_quote y la pregunta del asistente.
CREATE INDEX IF NOT EXISTS "ServiceQuote_client_id_status_issued_at_idx" ON "ServiceQuote" ("client_id", "status", "issued_at");
CREATE INDEX IF NOT EXISTS "ServiceQuote_contact_id_idx"                 ON "ServiceQuote" ("contact_id");
CREATE INDEX IF NOT EXISTS "ServiceQuote_tenant_id_idx"                  ON "ServiceQuote" ("tenant_id");
