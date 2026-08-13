// WP-05 — was defined locally (byte-for-byte identical) in eight files
// across the portal and admin app; one client-facing tier label, one
// source of truth. Keyed by plain string, not ChatbotTier: several
// call sites index it with a raw DB row's tier column, which isn't
// guaranteed to be one of the three known values, and fall back to the
// raw value (`TIER_LABEL[row.tier] ?? row.tier`) rather than crash on
// stale data.
export const TIER_LABEL: Record<string, string> = {
  starter: 'Web Starter',
  pro: 'Web Pro',
  premium: 'Web Premium',
};
