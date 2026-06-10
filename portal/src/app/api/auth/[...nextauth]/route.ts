// NextAuth.js v5 catch-all route (KAIA-753).
// Exposes /api/auth/signin, /api/auth/signout, /api/auth/callback/:provider,
// /api/auth/session, /api/auth/csrf, /api/auth/verify-request, etc.

import { handlers } from '../../../../../auth';

export const { GET, POST } = handlers;
