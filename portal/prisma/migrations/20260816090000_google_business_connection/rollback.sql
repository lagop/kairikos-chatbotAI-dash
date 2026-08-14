-- Rollback: WP-21 — conexión OAuth y almacenamiento cifrado de credenciales
--
-- Safe as a straight DROP as long as no GoogleBusinessConnection row has
-- been created yet (the FK constraints drop automatically with the
-- table). If any client has already connected, rolling back destroys
-- that connection's encrypted refresh token — the client would need to
-- reconnect via OAuth after a forward-migrate.

DROP TABLE IF EXISTS "GoogleBusinessConnection";
