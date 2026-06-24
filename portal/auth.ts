// =============================================================================
// Kairikos — NextAuth.js v5 + Credentials (email + password) (KAIA-2103)
//
// Replaces the previous magic-link / Nodemailer provider.
// The Credentials provider validates the submitted password against the
// argon2id hash stored in ChatbotClientUser.passwordHash.
//
// Sessions: JWT (no DB-backed session). The jwt callback embeds clientId from
// ChatbotClientUser so every protected route can resolve the caller without
// a DB round-trip.
// =============================================================================

import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/operator-crypto';

const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';

function buildAuthConfig(): NextAuthConfig {
  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  return {
    secret: authSecret,
    session: { strategy: 'jwt' },
    trustHost: true,
    pages: {
      signIn: '/portal/login',
      error: '/portal/login',
    },
    providers: [
      Credentials({
        name: 'credentials',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Contraseña', type: 'password' },
        },
        async authorize(credentials) {
          const email = (credentials?.email as string | undefined)?.toLowerCase().trim();
          const password = credentials?.password as string | undefined;
          if (!email || !password) return null;

          const record = await prisma.chatbotClientUser.findUnique({
            where: { nextAuthEmail: email },
            select: { id: true, clientId: true, passwordHash: true },
          });

          if (!record || !record.passwordHash) {
            // Unknown email or password not set — return null to surface
            // CredentialsSignin error, which maps to "invalid_credentials" in the UI.
            return null;
          }

          const valid = await verifyPassword(record.passwordHash, password);
          if (!valid) return null;

          return { id: record.id, email, clientId: record.clientId, role: 'client' as const };
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user }) {
        if (user && 'clientId' in user) {
          token.clientId = (user as { clientId: string }).clientId;
          token.role = (user as { role?: string }).role ?? 'client';
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user) {
          if (token.clientId) {
            (session.user as { clientId?: string }).clientId = token.clientId as string;
          }
          if (token.role) {
            (session.user as { role?: string }).role = token.role as string;
          }
        }
        return session;
      },
    },
  };
}

export const authConfig = buildAuthConfig();

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { SUPPORT_EMAIL };
