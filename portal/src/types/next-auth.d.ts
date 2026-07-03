// =============================================================================
// NextAuth.js v5 type augmentations (KAIA-753, KAIA-2875).
// Adds `clientId` and `role` to the session.user and JWT shapes so downstream
// consumers can read them without a re-cast.
// =============================================================================

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      clientId?: string;
      role?: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    clientId?: string;
    role?: string;
  }
}

export {};
