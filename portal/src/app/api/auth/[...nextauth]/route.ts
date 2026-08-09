// NextAuth.js v5 catch-all route (KAIA-753).
// Exposes /api/auth/signin, /api/auth/signout, /api/auth/callback/:provider,
// /api/auth/session, /api/auth/csrf, /api/auth/verify-request, etc.

import { handlers } from '../../../../../auth';

// KAIA-2857 — NextAuth handlers read cookies/headers on every request. Force
// dynamic rendering so Vercel never tries to prerender this catch-all into a
// static 500 (which is what happens when `auth()` throws inside a static
// build phase). Also helps when AUTH_SECRET/DATABASE_URL are missing: the
// runtime error is rendered as NextAuth's own `?error=Configuration` page
// (HTTP 500) instead of Vercel's `pages/_error` chunk.
export const dynamic = 'force-dynamic';

export const { GET, POST } = handlers;
