-- Migration: MetaChannelConnection.label
--
-- Human-readable name discovered at connect time (a Facebook Page's
-- name, or a WhatsApp label built from the WABA id) — externalId alone
-- is a raw Meta id (a page id, an Instagram business account id, a
-- phone number id), not fit to show a client in /portal/canales.
-- Nullable and additive: existing rows (none expected yet, this ships
-- in the same WP as the table itself) simply have label=NULL.

ALTER TABLE "MetaChannelConnection" ADD COLUMN "label" TEXT;
