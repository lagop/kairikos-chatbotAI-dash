// =============================================================================
// Kairikos — NextAuth.js v5 + Credentials (email + password) (KAIA-2103)
//
// Two Credentials providers split by role:
//   - portal-credentials : client users (role='client') → ChatbotClientUser
//   - admin-credentials  : operator users (role='operator') → Operator
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
      // portal-credentials: client user login via email + password
      Credentials({
        id: 'portal-credentials',
        name: 'portal-credentials',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Contraseña', type: 'password' },
        },
        async authorize(credentials) {
          const email = (credentials?.email as string | undefined)?.toLowerCase().trim();
          const password = credentials?.password as string | undefined;
          if (!email || !password) return null;

          // Look up the User row for this client user
          const user = await prisma.user.findUnique({
            where: { email },
            select: { id: true, role: true, passwordHash: true },
          });

          if (!user || user.role !== 'client' || !user.passwordHash) {
            return null;
          }

          if (user.passwordHash === '__must_reset__') {
            return null;
          }

          const valid = await verifyPassword(user.passwordHash, password);
          if (!valid) return null;

          // Resolve clientId from the linked ChatbotClientUser
          const clientUser = await prisma.chatbotClientUser.findUnique({
            where: { userId: user.id },
            select: { clientId: true },
          });

          return { id: user.id, email, clientId: clientUser?.clientId ?? null, role: 'client' };
        },
      }),
      // admin-credentials: operator login via email + password
      Credentials({
        id: 'admin-credentials',
        name: 'admin-credentials',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Contraseña', type: 'password' },
        },
        async authorize(credentials) {
          const email = (credentials?.email as string | undefined)?.toLowerCase().trim();
          const password = credentials?.password as string | undefined;
          if (!email || !password) return null;

          const operator = await prisma.operator.findUnique({
            where: { email },
            select: { id: true, email: true, passwordHash: true, isActive: true },
          });

          if (!operator || !operator.isActive || !operator.passwordHash) {
            return null;
          }

          if (operator.passwordHash === '__must_reset__') {
            return null;
          }

          const valid = await verifyPassword(operator.passwordHash, password);
          if (!valid) return null;

          return { id: operator.id, email: operator.email, role: 'operator' };
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          if ('clientId' in user) {
            token.clientId = (user as { clientId?: string }).clientId;
            token.role = (user as { role?: string }).role ?? 'client';
          } else if ('role' in user) {
            token.role = (user as { role?: string }).role!;
          }
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
