-- Migration: adds the Spanish numbering regulatory bundle/address SIDs
-- to TwilioOperatorCredential, so they can be set from
-- /admin/portal/settings/telephony alongside the account credential
-- pair instead of only via TWILIO_BUNDLE_SID/TWILIO_ADDRESS_SID on the
-- VPS .env. Not secret — cleartext columns, same as account_sid.

ALTER TABLE "TwilioOperatorCredential" ADD COLUMN "bundle_sid" TEXT;
ALTER TABLE "TwilioOperatorCredential" ADD COLUMN "address_sid" TEXT;
