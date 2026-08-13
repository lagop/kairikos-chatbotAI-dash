// =============================================================================
// WP-09 — shared tenant-resolution constant.
//
// The multi-tenant Phase 0 migration (KAIA-4258,
// 20260724130000_multi_tenant_phase0) added a nullable `tenant_id` to every
// client-scoped table and backfilled existing rows to a single seeded
// 'default' Tenant row (id below). It left the column nullable "until the
// API refactor (KAIA-4267) flips it to NOT NULL after the rollout
// completes" — but no write path was ever updated to actually populate
// `tenantId` on new rows, so every row created since that migration has
// kept accumulating with `tenant_id = NULL` right alongside the backfilled
// legacy rows. WP-09 is closing that gap: every create/upsert that mints a
// new client-scoped row now stamps a tenantId, so the column can
// eventually be flipped to NOT NULL without a continuous trickle of new
// violations (see docs/wp-09-tenant-not-null/ for the audit + migration
// prepared for that final step).
//
// There is no multi-tenant onboarding flow yet — every new ChatbotClient
// the portal creates (via POST /api/public/intake, the only client-minting
// path) belongs to this single default tenant until one exists. Once a
// real tenant-resolution flow lands, this constant becomes the fallback
// for "no tenant chosen" rather than the only possible value.
// =============================================================================

export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
