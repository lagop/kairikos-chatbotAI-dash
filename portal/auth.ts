// =============================================================================
// Kairikos — NextAuth.js v5 + Credentials (email + password) (KAIA-2103)
//
// Solo la entrada de CLIENTES (portal-credentials → ChatbotClientUser).
//
// La de operadores (admin-credentials) se retiró el 22/09/2026: daba acceso
// al admin con la contraseña sola, sin límite de intentos, y con un JWT que
// no se podía revocar durante 30 días. Los operadores entran ahora por
// /api/operator/login con segundo factor obligatorio, y su sesión es una
// OperatorSession en Postgres — ver src/lib/operator-login.ts. Un JWT
// antiguo con role 'operator' se invalida en el callback `jwt` de abajo.
//
// Sessions: JWT (no DB-backed session). The jwt callback embeds clientId from
// ChatbotClientUser so every protected route can resolve the caller without
// a DB round-trip.
// =============================================================================

import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { prisma } from '@/lib/prisma';
import { verifyPassword, passwordFingerprint, InMemoryRateLimiter } from '@/lib/operator-crypto';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { isPendingSignupHash } from '@/lib/pending-signup';

const SUPPORT_EMAIL = process.env.AUTH_SUPPORT_EMAIL ?? 'hola@kairikos.com';

// Hasta el 22/09/2026 este endpoint no limitaba intentos. En memoria: por
// proceso, y hay uno solo; un reinicio los pone a cero, que es aceptable
// para frenar la fuerza bruta, no para contabilidad.
const emailAttempts = new InMemoryRateLimiter(15 * 60_000);
const ipAttempts = new InMemoryRateLimiter(15 * 60_000);
const MAX_ATTEMPTS_PER_EMAIL = 10;
const MAX_ATTEMPTS_PER_IP = 30;

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
        async authorize(credentials, request) {
          const email = (credentials?.email as string | undefined)?.toLowerCase().trim();
          const password = credentials?.password as string | undefined;
          if (!email || !password) return null;

          const ip = request?.headers ? clientIpFromHeaders(request.headers) : 'unknown';
          if (!ipAttempts.check(`ip:${ip}`, MAX_ATTEMPTS_PER_IP)) return null;
          if (!emailAttempts.check(`email:${email}`, MAX_ATTEMPTS_PER_EMAIL)) return null;

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
          // Alta de autoservicio cuyo email aún no se ha confirmado: no entra
          // hasta pulsar el enlace del correo. Ver lib/pending-signup.ts.
          if (isPendingSignupHash(user.passwordHash)) {
            return null;
          }

          const valid = await verifyPassword(user.passwordHash, password);
          if (!valid) return null;

          // Resolve clientId from the linked ChatbotClientUser
          const clientUser = await prisma.chatbotClientUser.findUnique({
            where: { userId: user.id },
            select: { clientId: true },
          });

          // A8 — sellar la última entrada del cliente. Es una de las tres
          // señales de que alguien se va a ir ("lleva un mes sin asomarse"),
          // y hasta ahora no se podía ni preguntar porque solo el Operator
          // tenía lastLoginAt. Best-effort: que un fallo escribiéndolo no
          // impida entrar a nadie.
          // Optional chaining y catch: esto NO puede impedir un login. Los
          // tests de authorize mockean un prisma mínimo sin chatbotClient, y
          // en producción un fallo escribiendo una fecha no vale una sesión
          // perdida.
          await prisma.chatbotClient
            ?.update?.({ where: { id: clientUser?.clientId ?? '' }, data: { lastLoginAt: new Date() } })
            ?.catch?.(() => undefined);

          return {
            id: user.id,
            email,
            clientId: clientUser?.clientId ?? null,
            role: 'client',
            pwf: passwordFingerprint(user.passwordHash),
          };
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
          const pwf = (user as { pwf?: string }).pwf;
          if (pwf) token.pwf = pwf;
        }

        // Un JWT de operador es de antes del 22/09/2026: esa entrada ya no
        // existe y no puede seguir abriendo nada.
        if (token.role === 'operator') return null;

        // El token lleva la huella de la contraseña con la que se emitió.
        // Cambiarla (o que soporte la resetee) cierra las sesiones abiertas
        // en vez de dejarlas vivas hasta 30 días. Los tokens anteriores a
        // este cambio no la llevan y caen una vez: el cliente vuelve a entrar.
        if (token.sub) {
          const row = await prisma.user.findUnique({
            where: { id: token.sub },
            select: { passwordHash: true },
          });
          const current = row?.passwordHash;
          if (!current || current === '__must_reset__' || typeof token.pwf !== 'string') return null;
          if (passwordFingerprint(current) !== token.pwf) return null;
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
