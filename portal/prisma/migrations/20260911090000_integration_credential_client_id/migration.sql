-- Adds a cleartext client_id column to IntegrationCredential, so an
-- OAuth-client-style credential pair (Google Business/SEO/GA4 —
-- GOOGLE_*_OAUTH_CLIENT_ID/SECRET) can be pasted at
-- /admin/portal/settings/integrations alongside the existing
-- single-secret tools (google_places). Null for those. Not secret —
-- cleartext, same reasoning as TwilioOperatorCredential.account_sid.

ALTER TABLE "IntegrationCredential" ADD COLUMN "client_id" TEXT;
