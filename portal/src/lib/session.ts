import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { prisma } from './prisma';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from './portal-data';

export type SessionReason = 'no_session' | 'no_client_access' | 'cross_tenant';

export interface PortalSession {
  email: string | null;
  accessToken: string | null;
  userId: string | null;
  hasClientAccess: boolean;
  isOperator: boolean;
  clientSlug: string | null;
  clientId: string | null;
  reason?: SessionReason;
}

const OPERATOR_COOKIE = 'kairikos-portal-operator';
const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';

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
    hasClientAccess: true,
    isOperator: cookies().get(OPERATOR_COOKIE)?.value === '1',
    clientSlug: MOCK_CLIENT.slug,
    clientId: MOCK_CLIENT.id,
  };
}

export async function getSession(): Promise<PortalSession> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const isDevMock =
    !supabaseUrl ||
    supabaseUrl.includes('YOUR-PROJECT') ||
    supabaseUrl === 'https://invalid.supabase.co';

  if (isDevMock) {
    return resolveDevMockSession();
  }

  const session = await auth();
  if (!session?.user?.email) {
    return {
      email: null,
      accessToken: null,
      userId: null,
      hasClientAccess: false,
      isOperator: false,
      clientSlug: null,
      clientId: null,
      reason: 'no_session',
    };
  }
  const email = session.user.email.toLowerCase();
  const link = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: email },
    select: {
      clientId: true,
      client: { select: { slug: true } },
    },
  });
  return {
    email,
    accessToken: null,
    userId: session.user.id ?? null,
    hasClientAccess: Boolean(link?.clientId),
    isOperator: cookies().get(OPERATOR_COOKIE)?.value === '1',
    clientSlug: link?.client?.slug ?? null,
    clientId: link?.clientId ?? session.user.clientId ?? null,
    reason: link?.clientId ? undefined : 'no_client_access',
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
