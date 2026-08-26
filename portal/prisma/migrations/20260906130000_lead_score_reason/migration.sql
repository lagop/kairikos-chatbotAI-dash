-- Leads Fase 9 — the classifier's own justification for the score,
-- stored alongside it instead of leaving the number to speak for
-- itself. Additive, nullable: existing leads were scored (or not) by a
-- classifier that never produced this text, so NULL is the honest
-- state for all of them, not a guess.

ALTER TABLE "Lead" ADD COLUMN "score_reason" TEXT;
