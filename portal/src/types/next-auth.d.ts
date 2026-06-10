// =============================================================================
// NextAuth.js v5 type augmentations (KAIA-753).
// Adds `clientId` to the session.user and JWT shapes so downstream
// consumers can read it without a re-cast.
// =============================================================================

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      clientId?: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    clientId?: string;
  }
}

export {};
