import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { prisma } from './prisma';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from './portal-data';
import { constantTimeEqual } from './operator-crypto';
import { isPortalDevMock } from './portal-session';

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
  // KAIA-1909: production-stage QA bypass — honor the same operator-key
  // header the API routes (`/api/admin/portal/*`) already honor. When the
  // request carries `x-kaia-operator-key` matching `KAIA_OPERATOR_API_KEY`,
  // return an operator session without redirecting. This is intentionally
  // an explicit opt-in header — no cookie is required and no Supabase
  // configuration is touched — so it works on staging where the operator
  // cookie is never populated by middleware.
  const operatorKeyBypass = resolveOperatorKeyBypass();
  if (operatorKeyBypass) {
    return operatorKeyBypass;
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
  // the dev-mock cookie or the operator-key bypass above. Same bug class,
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
    isOperator: (userRow?.role ?? (session.user as { role?: string }).role) === 'operator',
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

// KAIA-1909 — production-stage operator bypass via `x-kaia-operator-key`
// header. Mirrors the gate the API route uses (`src/app/api/admin/portal/flows/route.ts`)
// so the same operator credential unlocks both the page and the JSON API.
// Constant-time comparison guards against timing oracles on the shared key.
export function resolveOperatorKeyBypass(): PortalSession | null {
  const envKey = process.env.KAIA_OPERATOR_API_KEY;
  if (!envKey) return null;
  let provided: string | null = null;
  try {
    provided = headers().get('x-kaia-operator-key');
  } catch {
    // headers() may throw outside a request context (e.g. background work).
    // Treat as "no header" rather than crashing.
    provided = null;
  }
  if (!provided) return null;
  if (!constantTimeEqual(provided, envKey)) return null;
  return {
    email: 'operator-key-bypass@kairikos.local',
    accessToken: 'operator-key',
    userId: 'operator-key-bypass',
    role: 'operator',
    hasClientAccess: true,
    isOperator: true,
    clientSlug: null,
    clientId: null,
  };
}

