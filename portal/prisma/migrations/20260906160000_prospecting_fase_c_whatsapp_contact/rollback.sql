-- Rollback for 20260906160000_prospecting_fase_c_whatsapp_contact.

ALTER TABLE "Lead" DROP COLUMN "auto_contact_error";
ALTER TABLE "Lead" DROP COLUMN "auto_contact_attempts";

ALTER TABLE "ProspectingCampaign" DROP COLUMN "auto_contact_paused_at";
ALTER TABLE "ProspectingCampaign" DROP COLUMN "consent_version";
ALTER TABLE "ProspectingCampaign" DROP COLUMN "consent_acknowledged_at";
