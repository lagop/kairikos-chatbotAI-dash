import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { prisma } from './prisma';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from './portal-data';
import { isPortalDevMock } from './portal-session';
import { SESSION_COOKIE_NAME, getValidSession, touchSession, type ValidOperatorSession } from './operator-session';

/** Marca de uso como mucho cada 5 minutos: cada página del admin pasa por
 *  aquí y no hace falta una escritura por petición para el tiempo de
 *  inactividad de 12 horas. */
const TOUCH_EVERY_MS = 5 * 60_000;

async function resolveOperatorFromCookie(): Promise<ValidOperatorSession | null> {
  let sessionId: string | undefined;
  try {
    sessionId = cookies().get(SESSION_COOKIE_NAME)?.value;
  } catch {
    return null;
  }
  if (!sessionId) return null;
  const session = await getValidSession(sessionId);
  if (session && Date.now() - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    touchSession(sessionId).catch(() => {});
  }
  return session;
}

export type SessionReason = 'no_session' | 'no_client_access' | 'cross_tenant';

export interface PortalSession {
  email: string | null;
  accessToken: string | null;
  userId: string | null;
  role: string | null;
  hasClientAccess: boolean;
  isOperator: boolean;
  clientSlug: string | null;
  clientId: string | null;
  reason?: SessionReason;
}

const OPERATOR_COOKIE = 'kairikos-portal-operator';
const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const DEV_SESSION_ACTIVE_COOKIE = 'kairikos-portal-dev-session-active';

// Resolves a session for the current request. In dev-mock mode (Supabase
// env not configured), this auto-activates the mock session without
// requiring middleware to set cookies first. KAIA-835: middleware edge
// runtime crash workaround — session activates based on env absence, not
// on a pre-set cookie.
async function resolveDevMockSession(): Promise<PortalSession> {
  return {
    email: MOCK_CLIENT.primaryContactEmail,
    accessToken: 'dev-mock',
    userId: 'mock-user-001',
    role: 'client',
    hasClientAccess: true,
    isOperator: false,
    clientSlug: MOCK_CLIENT.slug,
    clientId: MOCK_CLIENT.id,
  };
}

export async function getSession(): Promise<PortalSession> {
  // Seguridad (22/09/2026) — ser operador sale SOLO de la OperatorSession
  // (cookie + fila en Postgres), que nace después del segundo factor y se
  // puede revocar. Antes salía del rol del JWT de NextAuth: bastaba la
  // contraseña, no había límite de intentos y el token valía 30 días aunque
  // se cambiara la contraseña o se desactivara al operador. Ver
  // operator-login.ts. Va primero: con las dos sesiones en el mismo
  // navegador, manda la de operador.
  const operator = await resolveOperatorFromCookie();
  if (operator) {
    return {
      email: operator.email.toLowerCase(),
      accessToken: null,
      userId: operator.operatorId,
      role: 'operator',
      hasClientAccess: false,
      isOperator: true,
      clientSlug: null,
      clientId: null,
      reason: 'no_client_access',
    };
  }

  // A real, valid NextAuth session (client OR operator) always takes
  // priority over the dev-mock fallback below. This used to be gated the
  // other way around — isPortalDevMock() (a Supabase-env-var heuristic
  // unrelated to whether a real session exists) short-circuited BEFORE
  // auth() was ever called, so in any environment with placeholder
  // Supabase vars (e.g. local dev, where Supabase isn't used for auth at
  // all) a genuinely logged-in operator via the real /admin/login form
  // was silently bounced to "no session" — /admin/portal/* was
  // structurally unreachable through the real login form, only through
  // the dev-mock cookie. Same bug class,
  // same fix, as resolveClientFromSession() in portal-session.ts.
  let session;
  try {
    session = await auth();
  } catch (err) {
    console.error('[getSession] auth() failed:', err);
    session = null;
  }

  if (!session?.user?.email) {
    // WP-06 — this used to be a private byte-for-byte copy of
    // isPortalDevMock() (KAIA-1519 already documented the two had to be
    // kept in sync by hand so the layout and the wizard agreed on
    // dev-mock detection). Importing the one export removes the chance
    // of the copies drifting.
    if (isPortalDevMock()) {
      // KAIA-4011 — dev-mock auto-login is gated on the
      // `kairikos-portal-dev-session-active` flag cookie. The flag is set
      // by an explicit dev-mock login action and cleared by the logout
      // action. Without the flag, dev-mock returns the no-session shape
      // so the layout redirects to /portal/login — restoring the
      // unauth → 307 contract and the back-nav protection that the QA
      // verdict flagged as missing.
      const hasActiveDevSession = Boolean(cookies().get(DEV_SESSION_ACTIVE_COOKIE)?.value);
      if (hasActiveDevSession) {
        return resolveDevMockSession();
      }
    }
    return {
      email: null,
      accessToken: null,
      userId: null,
      role: null,
      hasClientAccess: false,
      isOperator: false,
      clientSlug: null,
      clientId: null,
      reason: 'no_session',
    };
  }
  const email = session.user.email.toLowerCase();

  // Resolve role from the User table; default to 'client' if not found.
  let userRow;
  let clientUser;
  try {
    userRow = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });

    // Resolve clientId from the linked ChatbotClientUser via userId
    clientUser = userRow
      ? await prisma.chatbotClientUser.findUnique({
          where: { userId: userRow.id },
          select: { clientId: true, client: { select: { email: true } } },
        })
      : null;
  } catch (err) {
    console.error('[getSession] Prisma query failed:', err);
    return {
      email,
      accessToken: null,
      userId: session.user.id ?? null,
      role: null,
      hasClientAccess: false,
      isOperator: false,
      clientSlug: null,
      clientId: null,
      reason: 'no_session',
    };
  }

  return {
    email,
    accessToken: null,
    userId: session.user.id ?? null,
    role: userRow?.role ?? (session.user as { role?: string }).role ?? null,
    hasClientAccess: Boolean(clientUser?.clientId),
    // Nunca desde el JWT: ver resolveOperatorFromCookie más arriba.
    isOperator: false,
    clientSlug: clientUser?.client?.email ?? null,
    clientId: clientUser?.clientId ?? (session.user as { clientId?: string }).clientId ?? null,
    reason: clientUser?.clientId ? undefined : 'no_client_access',
  };
}

export async function requirePortalSession(): Promise<PortalSession> {
  const session = await getSession();
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  return session;
}

const KNOWN_TENANT_SLUGS = new Set<string>([MOCK_CLIENT.slug, MOCK_SECONDARY_CLIENT.slug]);

export function assertSameClient(session: PortalSession, requestedSlug: string | null) {
  if (!requestedSlug) return;
  if (!session.clientSlug) return;
  if (session.clientSlug === requestedSlug) return;
  if (KNOWN_TENANT_SLUGS.has(requestedSlug)) {
    redirect('/portal/login?reason=cross_tenant');
  }
}

export function setSessionCookieMarker(value: string) {
  cookies().set('kairikos-portal-session', value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}
