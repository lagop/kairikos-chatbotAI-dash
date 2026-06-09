import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient, isSupabaseConfigured, SUPABASE_ANON_KEY } from './supabase';
import { MOCK_CLIENT, MOCK_SECONDARY_CLIENT } from './portal-data';

export type SessionReason = 'no_session' | 'no_client_access' | 'cross_tenant';

export interface PortalSession {
  email: string | null;
  accessToken: string | null;
  userId: string | null;
  hasClientAccess: boolean;
  isOperator: boolean;
  clientSlug: string | null;
  reason?: SessionReason;
}

const SESSION_COOKIE = 'kairikos-portal-session';
const OPERATOR_COOKIE = 'kairikos-portal-operator';
const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';

export async function getSession(): Promise<PortalSession> {
  if (!isSupabaseConfigured) {
    // In dev (no Supabase), require a dev-session cookie so that Playwright
    // tests can simulate "no session" by clearing cookies. The middleware
    // auto-issues this cookie on first hit.
    const devSession = cookies().get(DEV_SESSION_COOKIE)?.value;
    if (!devSession) {
      return {
        email: null,
        accessToken: null,
        userId: null,
        hasClientAccess: false,
        isOperator: false,
        clientSlug: null,
        reason: 'no_session',
      };
    }
    return {
      email: MOCK_CLIENT.primaryContactEmail,
      accessToken: SUPABASE_ANON_KEY,
      userId: 'mock-user-001',
      hasClientAccess: true,
      isOperator: cookies().get(OPERATOR_COOKIE)?.value === '1',
      clientSlug: MOCK_CLIENT.slug,
    };
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return {
      email: null,
      accessToken: null,
      userId: null,
      hasClientAccess: false,
      isOperator: false,
      clientSlug: null,
      reason: 'no_session',
    };
  }
  const { data: link } = await supabase
    .from('chatbot_client_users')
    .select('chatbot_client_id, chatbot_clients:chatbot_client_id (slug)')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();
  const linked = link as unknown as
    | { chatbot_client_id: string; chatbot_clients: { slug: string } | null }
    | null;
  return {
    email: session.user.email ?? null,
    accessToken: session.access_token,
    userId: session.user.id,
    hasClientAccess: Boolean(linked?.chatbot_client_id),
    isOperator: cookies().get(OPERATOR_COOKIE)?.value === '1',
    clientSlug: linked?.chatbot_clients?.slug ?? null,
    reason: linked?.chatbot_client_id ? undefined : 'no_client_access',
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
  cookies().set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}
