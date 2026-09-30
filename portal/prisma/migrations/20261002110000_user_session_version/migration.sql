-- La versión de las sesiones del cliente (ver User.sessionVersion).
-- Cerrar sesión la sube y todo JWT emitido antes deja de valer.
ALTER TABLE "User" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
