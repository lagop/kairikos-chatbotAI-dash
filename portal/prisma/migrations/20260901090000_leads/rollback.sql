-- Rollback: Leads ("Captación con IA" / 'leads' product) — Fase 1
--
-- Safe as a straight drop as long as no Lead/LeadAudit row has been
-- created yet (the expected state immediately after this migration
-- lands). LeadAudit first (it FKs to Lead), then Lead.

DROP TABLE IF EXISTS "LeadAudit";
DROP TABLE IF EXISTS "Lead";
