// WP-05 — was defined locally (byte-for-byte identical) in eight files
// across the portal and admin app; one client-facing tier label, one
// source of truth. Keyed by plain string, not ChatbotTier: several
// call sites index it with a raw DB row's tier column, which isn't
// guaranteed to be one of the three known values, and fall back to the
// raw value (`TIER_LABEL[row.tier] ?? row.tier`) rather than crash on
// stale data.
//
// Bug found 2026-08-21 via manual QA: these three values were prefixed
// "Web ..." — but starter/pro/premium are the Chatbot product's tiers
// (see prisma/seed.ts PRODUCT_CATALOG: 'chatbot' is the only product
// with these three tier names; 'web' has a single 'standard', custom-
// quoted tier and has never used starter/pro/premium). Every client on
// a Chatbot plan saw their own plan mislabeled as a "Web" plan on
// /portal/perfil, /portal/billing, and every admin view listed above.
export const TIER_LABEL: Record<string, string> = {
  starter: 'Chatbot Starter',
  pro: 'Chatbot Pro',
  premium: 'Chatbot Premium',
};
