// =============================================================================
// Kairikos — Custom NextAuth Prisma adapter (KAIA-1736).
//
// The off-the-shelf `@auth/prisma-adapter` reads `prisma.user.*` on every
// magic-link request (see node_modules/@auth/prisma-adapter/src/index.ts:34
// — `getUserByEmail: (email) => p.user.findUnique(...)`). The Kairikos
// Prisma schema does NOT define a `User` model — the user row is
// `ChatbotClientUser` (keyed by `nextAuthEmail`, see prisma/schema.prisma).
// At runtime `p.user` is `undefined`, so the first magic-link request
// throws `Cannot read properties of undefined (reading 'findUnique')` and
// `/api/auth/signin/nodemailer` redirects to `?error=Configuration`.
//
// This adapter maps NextAuth's `Adapter` surface onto the actual schema
// tables that exist:
//   * `ChatbotClientUser` (nextAuthEmail unique) — for getUser / getUserByEmail
//   * `VerificationToken` — for createVerificationToken / useVerificationToken
//
// We do NOT touch `Account` or `Session` — the project runs JWT sessions
// (`session: { strategy: 'jwt' }`) so those adapter methods are never called,
// and the Email provider only needs `getUserByEmail` + `createVerificationToken`
// + `useVerificationToken` on the send-token path
// (`@auth/core/lib/actions/signin/send-token.js`).
//
// `createUser` / `updateUser` / `deleteUser` are still implemented so future
// OAuth providers can be added without re-touching this file; they upsert
// into `ChatbotClientUser` keyed by `nextAuthEmail`. `id` is the cuid of the
// row (matches the existing user identifier pattern used by the rest of the
// portal — see src/lib/session.ts).
// =============================================================================

import type { Adapter, AdapterUser, VerificationToken } from '@auth/core/adapters';
import type { ChatbotClientUser } from '@prisma/client';
import { prisma } from '@/lib/prisma';

function userToAdapter(row: ChatbotClientUser): AdapterUser {
  return {
    id: row.id,
    email: row.nextAuthEmail,
    emailVerified: null,
    name: null,
    image: null,
  };
}

export function KairikosPrismaAdapter(): Adapter {
  return {
    async createUser(user: AdapterUser): Promise<AdapterUser> {
      const email = (user.email ?? '').toLowerCase().trim();
      if (!email) {
        throw new Error('createUser: email is required');
      }
      const link = await prisma.chatbotClientUser.findUnique({
        where: { nextAuthEmail: email },
      });
      if (!link) {
        throw new Error(
          `createUser: no ChatbotClientUser exists for ${email}. ` +
            'The portal signIn callback rejects unknown emails, so this ' +
            'path should be unreachable — investigate upstream.',
        );
      }
      return userToAdapter(link);
    },

    async getUser(id: string): Promise<AdapterUser | null> {
      const row = await prisma.chatbotClientUser.findUnique({ where: { id } });
      return row ? userToAdapter(row) : null;
    },

    async getUserByEmail(email: string): Promise<AdapterUser | null> {
      const normalized = email.toLowerCase().trim();
      const row = await prisma.chatbotClientUser.findUnique({
        where: { nextAuthEmail: normalized },
      });
      return row ? userToAdapter(row) : null;
    },

    async updateUser(user: Partial<AdapterUser> & Pick<AdapterUser, 'id'>) {
      if (user.email) {
        const normalized = user.email.toLowerCase().trim();
        const link = await prisma.chatbotClientUser.update({
          where: { id: user.id },
          data: { nextAuthEmail: normalized },
        });
        return userToAdapter(link);
      }
      const link = await prisma.chatbotClientUser.findUnique({ where: { id: user.id } });
      if (!link) {
        throw new Error(`updateUser: ChatbotClientUser ${user.id} not found`);
      }
      return userToAdapter(link);
    },

    async deleteUser(userId: string): Promise<void> {
      await prisma.chatbotClientUser.delete({ where: { id: userId } });
    },

    async createVerificationToken(token: VerificationToken) {
      await prisma.verificationToken.create({
        data: {
          identifier: token.identifier,
          token: token.token,
          expires: token.expires,
        },
      });
      return token;
    },

    async useVerificationToken({ identifier, token }) {
      try {
        const row = await prisma.verificationToken.delete({
          where: { identifier_token: { identifier, token } },
        });
        return {
          identifier: row.identifier,
          token: row.token,
          expires: row.expires,
        };
      } catch (error: unknown) {
        // P2025 = "record to delete does not exist". The token was already
        // consumed (double-click, network retry). Return null so Auth.js
        // surfaces a clean "expired or invalid link" rather than a 500.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error as { code?: string }).code === 'P2025'
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}
