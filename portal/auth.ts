// =============================================================================
// Kairikos — NextAuth.js v5 + Resend magic-link (KAIA-753)
//
// Trust boundary (plan rev 3, portal): the NextAuth session, not a Postgres
// RLS predicate. Every protected portal route resolves clientId from
// `ChatbotClientUser.nextAuthEmail = session.user.email` (see src/lib/session.ts
// and prisma/README.md "Row isolation rule").
//
// Provider: Resend via the built-in Email provider (`@auth/core/providers/nodemailer`
// is NOT used — Resend has its own HTTPS API). The Email provider's
// `sendVerificationRequest` is overridden to POST to /v1/emails via the
// `resend` SDK.
//
// Sessions: JWT (no DB-backed session). The custom NextAuth adapter
// (`@/lib/auth-adapter`) handles VerificationToken storage (Email
// provider's click-once token) and maps user lookups onto the existing
// `ChatbotClientUser` table — see KAIA-1736 for why we do not use
// `@auth/prisma-adapter` (the schema has no `User` model).
//
// signIn callback: rejects unknown emails with a friendly, user-actionable
// error ("account not set up — contact support"). Returns `false` so the
// flow short-circuits BEFORE Resend is hit and a token row is inserted.
// =============================================================================

import NextAuth, { type NextAuthConfig } from 'next-auth';
import Nodemailer from 'next-auth/providers/nodemailer';
import { prisma } from '@/lib/prisma';
import { sendViaResend } from '@/lib/auth-email';
import { KairikosPrismaAdapter } from '@/lib/auth-adapter';

const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';

const SUPPORT_HINT = `Tu cuenta no está configurada todavía. Escríbenos a ${SUPPORT_EMAIL} para activarla.`;

function buildAuthConfig(): NextAuthConfig {
  const fromAddress = process.env.AUTH_EMAIL_FROM ?? 'Kairikos Portal <hola@kairikos.com>';
  const resendApiKey = process.env.RESEND_API_KEY ?? '';
  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  return {
    secret: authSecret,
    adapter: KairikosPrismaAdapter(),
    session: { strategy: 'jwt' },
    trustHost: true,
    pages: {
      signIn: '/portal/login',
      error: '/portal/login',
    },
    providers: [
      Nodemailer({
        server: {
          host: 'smtp.resend.com',
          port: 465,
          auth: { user: 'resend', pass: resendApiKey },
        },
        from: fromAddress,
        sendVerificationRequest: sendViaResend,
      }),
    ],
    callbacks: {
      async signIn({ user }) {
        const email = user.email?.toLowerCase().trim();
        if (!email) return false;
        const known = await prisma.chatbotClientUser.findUnique({
          where: { nextAuthEmail: email },
          select: { clientId: true },
        });
        if (!known) {
          throw new Error(SUPPORT_HINT);
        }
        return true;
      },
      async jwt({ token, user }) {
        if (user?.email) {
          const link = await prisma.chatbotClientUser.findUnique({
            where: { nextAuthEmail: user.email.toLowerCase() },
            select: { clientId: true },
          });
          if (link) token.clientId = link.clientId;
        }
        return token;
      },
      async session({ session, token }) {
        if (token.clientId && session.user) {
          (session.user as { clientId?: string }).clientId = token.clientId as string;
        }
        return session;
      },
    },
  };
}

export const authConfig = buildAuthConfig();

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
