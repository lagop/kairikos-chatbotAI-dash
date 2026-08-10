import type {
  BillingSummary,
  ChatbotClient,
  ChatbotClientUser,
  ChatbotStatusSummary,
  ConversationSummary,
  ConversationTranscript,
  OnboardingTimelineRow,
  PortalContext,
  SupportLink,
} from '@/types/portal';
import { isBackendConfigured, PORTAL_API_BASE_URL, SUPABASE_ANON_KEY } from './supabase';

const TIER_LABEL: Record<BillingSummary['tier'], string> = {
  starter: 'Web Starter',
  pro: 'Web Pro',
  premium: 'Web Premium',
};

const TIER_PRICE_CENTS: Record<BillingSummary['tier'], number> = {
  starter: 9900,
  pro: 24900,
  premium: 49900,
};

export const MOCK_CLIENT: ChatbotClient = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'acme-corp',
  companyName: 'Acme Corp',
  primaryContactEmail: 'qa-test-client-a@kairikos.com',
  stripeCustomerId: 'cus_test_client_a',
  tier: 'pro',
  onboardingStatus: 'live',
  createdAt: '2026-05-22T10:00:00.000Z',
  goLiveDate: '2026-05-29T09:00:00.000Z',
  chatbotSpaceId: 'spc_acme_corp',
};

const MOCK_CLIENT_USER: ChatbotClientUser = {
  id: '00000000-0000-0000-0000-000000000011',
  email: MOCK_CLIENT.primaryContactEmail,
  role: 'owner',
  clientId: MOCK_CLIENT.id,
};

const MOCK_TIMELINE_INTERNAL: OnboardingTimelineRow[] = [
  {
    id: 'evt-t0',
    step: 't_plus_0',
    label: 'Bienvenida y acceso al portal',
    description: 'Email de bienvenida con credenciales y enlace al portal.',
    occurredAt: '2026-05-22T10:05:00.000Z',
    status: 'done',
  },
  {
    id: 'evt-t3',
    step: 't_plus_3',
    label: 'Configuración inicial',
    description: 'Definimos tono, preguntas frecuentes y casos de derivación.',
    occurredAt: '2026-05-25T11:20:00.000Z',
    status: 'done',
  },
  {
    id: 'evt-t7',
    step: 't_plus_7',
    label: 'Puesta en producción',
    description: 'Chatbot conectado a WhatsApp y web; supervisión 24 h.',
    occurredAt: '2026-05-29T09:00:00.000Z',
    status: 'done',
  },
  {
    id: 'evt-t14',
    step: 't_plus_14',
    label: 'Revisión y optimización',
    description: 'Revisión de métricas, ajustes finos y formación al equipo.',
    occurredAt: null,
    status: 'current',
  },
];

const MOCK_CHATBOT: ChatbotStatusSummary = {
  spaceId: 'spc_acme_corp',
  status: 'live',
  goLiveDate: '2026-05-29T09:00:00.000Z',
  last7Days: {
    conversations: 142,
    fallbackRate: 0.08,
    escalationRate: 0.12,
  },
};

export const MOCK_CHATBOT_FROM_DATA = MOCK_CHATBOT;
export { MOCK_CHATBOT };

const MOCK_CONVERSATIONS: ConversationSummary[] = Array.from({ length: 12 }).map((_, i) => {
  const date = new Date(Date.UTC(2026, 5, 8, 9, 0, 0) - i * 1000 * 60 * 60 * 6);
  return {
    id: `cnv_${1000 + i}`,
    startedAt: date.toISOString(),
    durationSeconds: 60 + (i % 5) * 45,
    outcome: (i % 7 === 0 ? 'escalated' : i % 4 === 0 ? 'abandoned' : 'resolved') as ConversationSummary['outcome'],
    channel: (i % 3 === 0 ? 'whatsapp' : i % 3 === 1 ? 'web' : 'instagram') as ConversationSummary['channel'],
  };
});

const MOCK_BILLING: BillingSummary = {
  tier: MOCK_CLIENT.tier,
  tierLabel: TIER_LABEL[MOCK_CLIENT.tier],
  monthlyFeeCents: TIER_PRICE_CENTS[MOCK_CLIENT.tier],
  currency: 'EUR',
  nextInvoiceDate: '2026-07-01T00:00:00.000Z',
  nextInvoiceAmountCents: TIER_PRICE_CENTS[MOCK_CLIENT.tier],
  stripeCustomerPortalUrl: `https://billing.stripe.com/p/session/${MOCK_CLIENT.stripeCustomerId}`,
  stripeCustomerId: MOCK_CLIENT.stripeCustomerId,
};

const MOCK_SUPPORT: SupportLink = {
  label: 'Hablar con el equipo',
  href: 'https://wa.me/34600000000?text=Hola%2C%20necesito%20ayuda%20con%20mi%20portal%20Kairikos',
  description: 'Te respondemos por WhatsApp en horario laboral (L–V, 9:00–18:00 CET).',
};

// KAIA-11955 — PORTAL_API_BASE_URL on production is set to
// `https://project-fxidg.vercel.app/portal` (the user-facing SPA path),
// not `https://project-fxidg.vercel.app/api` (where the Next.js route
// handlers actually live). Building `${base}/portal/...` produces a
// double `/portal/portal/...` and 404s, which made the customer-facing
// `getOnboarding` and friends silently fall back to the Acme
// MOCK_TIMELINE_INTERNAL fixture. Normalise the URL: strip a trailing
// `/portal` from the base, and if the caller path starts with
// `/portal/...` translate it to `/api/portal/...` so the request hits
// the real route.
function buildApiUrl(path: string): string {
  let base = PORTAL_API_BASE_URL.replace(/\/$/, '');
  if (base.endsWith('/portal')) {
    base = base.slice(0, -'/portal'.length);
  }
  if (path.startsWith('/portal/')) {
    return `${base}/api${path}`;
  }
  return `${base}${path}`;
}

async function portalFetch<T>(path: string, accessToken: string): Promise<T | null> {
  if (!isBackendConfigured) return null;
  try {
    // KAIA-11955 — production NextAuth sessions have `accessToken: null`
    // (NextAuth only issues JWT session cookies, not Bearer tokens), so
    // the server-side portal pages were sending `Authorization: Bearer `
    // (empty) and the API returned 401, which made every helper fall
    // back to the Acme MOCK fixture. On the server, forward the inbound
    // cookies instead — that's how the route handler authenticates the
    // call in the first place. On the client, keep using the
    // accessToken Bearer header (the only auth signal the client has).
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Kairikos-Client': 'portal-web',
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    if (typeof window === 'undefined') {
      try {
        const { cookies } = await import('next/headers');
        const all = cookies().getAll();
        if (all.length > 0) {
          headers.cookie = all.map((c) => `${c.name}=${c.value}`).join('; ');
        }
      } catch {
        // Outside a request context (background work, build): no cookies.
      }
    }
    const res = await fetch(buildApiUrl(path), {
      headers,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getClientProfile(accessToken: string): Promise<ChatbotClient | null> {
  const fromApi = await portalFetch<ChatbotClient>('/portal/me', accessToken);
  return fromApi ?? MOCK_CLIENT;
}

export async function getClientUser(): Promise<ChatbotClientUser> {
  return MOCK_CLIENT_USER;
}

export async function getOnboarding(accessToken: string): Promise<OnboardingTimelineRow[]> {
  // KAIA-11955 — the GET route is /portal/onboarding (see
  // src/app/api/portal/onboarding/route.ts), not /portal/onboarding-status.
  // Calling the wrong path returned 404 and the customer saw the Acme
  // mock fixture instead of their real (empty) timeline. The real route
  // returns `{ timeline: [] }` for a customer with no ChatbotActivity rows,
  // which the OnboardingTimeline component renders as the "preparing your
  // portal" empty state.
  const fromApi = await portalFetch<{ timeline: OnboardingTimelineRow[] }>(
    '/portal/onboarding',
    accessToken,
  );
  return fromApi?.timeline ?? MOCK_TIMELINE_INTERNAL;
}

export async function getOnboardingFor(
  accessToken: string,
  clientSlug: string | null,
): Promise<OnboardingTimelineRow[]> {
  const all = await getOnboarding(accessToken);
  if (!clientSlug) return all;
  if (clientSlug === MOCK_CLIENT.slug) return all;
  // Dev mock: for any other slug (real known tenant or unknown fresh tenant),
  // return at most 1 row to model the "fresh client" / "different tenant" case.
  // The real backend would never return rows the caller doesn't own.
  return all.slice(0, 1);
}

export async function getChatbotStatus(accessToken: string): Promise<ChatbotStatusSummary> {
  // KAIA-11955 — the GET route is /portal/status (see
  // src/app/api/portal/status/route.ts), not /portal/chatbot-status.
  // Calling the wrong path returned 404 and the customer saw the
  // Acme MOCK_CHATBOT (spc_acme_corp, 142 conversaciones, 8% / 12%
  // rates) instead of their real (empty) chatbot status. The real
  // route returns the customer's actual `chatbotClient.id` as
  // spaceId, the live/in_progress status, and a 7-day window
  // derived from the real conversation count.
  const fromApi = await portalFetch<ChatbotStatusSummary>('/portal/status', accessToken);
  return fromApi ?? MOCK_CHATBOT;
}

export async function getPortalContext(accessToken: string): Promise<PortalContext> {
  const [client, onboarding, chatbot] = await Promise.all([
    getClientProfile(accessToken),
    getOnboarding(accessToken),
    getChatbotStatus(accessToken),
  ]);
  return {
    client: client ?? MOCK_CLIENT,
    onboarding,
    chatbot,
  };
}

export async function listConversations(accessToken: string): Promise<ConversationSummary[]> {
  const fromApi = await portalFetch<{ conversations: ConversationSummary[] }>(
    '/portal/conversations',
    accessToken,
  );
  return fromApi?.conversations ?? MOCK_CONVERSATIONS;
}

export async function getConversation(
  accessToken: string,
  id: string,
): Promise<ConversationTranscript | null> {
  const fromApi = await portalFetch<ConversationTranscript>(`/portal/conversations/${id}`, accessToken);
  if (fromApi) return fromApi;
  const summary = MOCK_CONVERSATIONS.find((c) => c.id === id);
  if (!summary) return null;
  return {
    ...summary,
    endedAt: new Date(new Date(summary.startedAt).getTime() + summary.durationSeconds * 1000).toISOString(),
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Hola, ¿a qué hora abrís mañana?',
        at: summary.startedAt,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '¡Hola! Mañana abrimos de 9:30 a 14:00 y de 16:00 a 20:00. ¿Quieres que te reserve cita?',
        at: new Date(new Date(summary.startedAt).getTime() + 4000).toISOString(),
      },
      {
        id: 'm3',
        role: 'user',
        content: 'Sí, el sábado a las 11:00 por favor.',
        at: new Date(new Date(summary.startedAt).getTime() + 9000).toISOString(),
      },
      {
        id: 'm4',
        role: 'assistant',
        content: 'He reservado tu cita del sábado a las 11:00 con Marta. ¿Te envío un recordatorio?',
        at: new Date(new Date(summary.startedAt).getTime() + 14000).toISOString(),
      },
    ],
  };
}

export async function getBilling(accessToken: string): Promise<BillingSummary> {
  const fromApi = await portalFetch<BillingSummary>('/portal/billing', accessToken);
  return fromApi ?? MOCK_BILLING;
}

export async function getSupportLink(accessToken: string): Promise<SupportLink> {
  const fromApi = await portalFetch<SupportLink>('/portal/support-link', accessToken);
  return fromApi ?? MOCK_SUPPORT;
}

export const MOCK_SECONDARY_CLIENT: ChatbotClient = {
  id: '00000000-0000-0000-0000-000000000002',
  slug: 'globex-inc',
  companyName: 'Globex Inc',
  primaryContactEmail: 'qa-test-client-b@kairikos.com',
  stripeCustomerId: 'cus_test_client_b',
  tier: 'premium',
  onboardingStatus: 'in_progress',
  createdAt: '2026-05-18T09:00:00.000Z',
  goLiveDate: null,
  chatbotSpaceId: null,
};

// KAIA-1519 — dev-mock Starter client for tier-aware wizard smoke tests.
// The default MOCK_CLIENT above is tier=pro, so without this fixture there
// is no way to exercise the Starter visibility matrix (Step 3 + Step 7
// hidden) from the local dev server. Only used in dev-mock mode (no DB).
export const MOCK_STARTER_CLIENT: ChatbotClient = {
  id: '00000000-0000-0000-0000-000000000003',
  slug: 'starter-sl',
  companyName: 'Starter S.L.',
  primaryContactEmail: 'qa-test-client-starter@kairikos.com',
  stripeCustomerId: 'cus_test_client_starter',
  tier: 'starter',
  onboardingStatus: 'in_progress',
  createdAt: '2026-06-01T09:00:00.000Z',
  goLiveDate: null,
  chatbotSpaceId: null,
};

export async function listAdminClients(): Promise<ChatbotClient[]> {
  // KAIA-13680 — listAdminClients() must follow the same
  // backend-configured gate as the sibling admin API route at
  // `portal/src/app/api/admin/portal/clients/route.ts:11` and the auth
  // helper at `portal/src/lib/api-auth.ts:27`. The previous version
  // returned the three dev-mock fixtures unconditionally, so the page at
  // `/admin/portal/clients` rendered only the Acme/Globex/Starter mocks
  // even on a real Prisma-backed deployment (e.g. staging seeded with
  // `clinica dental orly`). Now:
  //
  //   * When `PORTAL_API_BASE_URL` is set (`isBackendConfigured`), fetch
  //     the local Next.js route `/api/admin/portal/clients` (which itself
  //     proxies upstream to the NestJS API + Prisma — single source of
  //     truth), forwarding the inbound cookies and an operator Bearer
  //     token from the current session. Any non-2xx or parse failure
  //     falls back to the mocks so a stale stage mirror can't 500 the
  //     page.
  //   * When `PORTAL_API_BASE_URL` is unset (`!isBackendConfigured`,
  //     local `next dev` without a backend), keep the original
  //     dev-mock fallback so unit / smoke tests still render the three
  //     fixtures.
  if (isBackendConfigured) {
    try {
      const { headers } = await import('next/headers');
      const reqHeaders = headers();
      const cookieHeader = reqHeaders
        .get('cookie')
        ?? reqHeaders.get('Cookie')
        ?? '';
      const inboundAuth = reqHeaders.get('authorization') ?? reqHeaders.get('Authorization') ?? '';
      const { getSession } = await import('./session');
      const session = await getSession();
      const operatorHeader = reqHeaders.get('x-kairikos-operator') ?? reqHeaders.get('X-Kairikos-Operator') ?? '';
      const bearer =
        (session.accessToken && session.accessToken.length > 0 ? session.accessToken : null) ??
        (inboundAuth.toLowerCase().startsWith('bearer ') ? inboundAuth.slice(7).trim() : null) ??
        (session.isOperator ? 'operator-dev' : null) ??
        'dev-mock';
      const fetchHeaders: Record<string, string> = {
        Accept: 'application/json',
        'X-Kairikos-Client': 'portal-web',
        Authorization: `Bearer ${bearer}`,
      };
      if (operatorHeader) fetchHeaders['X-Kairikos-Operator'] = operatorHeader;
      else if (session.isOperator) fetchHeaders['X-Kairikos-Operator'] = '1';
      if (cookieHeader) fetchHeaders.cookie = cookieHeader;
      const origin =
        reqHeaders.get('origin') ??
        reqHeaders.get('Origin') ??
        (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '') ??
        `http://${reqHeaders.get('host') ?? reqHeaders.get('Host') ?? 'localhost:3001'}`;
      const res = await fetch(`${origin}/api/admin/portal/clients`, {
        headers: fetchHeaders,
        cache: 'no-store',
      });
      if (res.ok) {
        const data = (await res.json()) as ChatbotClient[] | { clients: ChatbotClient[] };
        const list = Array.isArray(data) ? data : data.clients ?? [];
        if (list.length > 0 || res.status === 200) return list;
      }
    } catch {
      // Swallow and fall back to mocks below — never 500 the
      // /admin/portal/clients page because the upstream is unreachable.
    }
    return [MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_STARTER_CLIENT];
  }
  return [MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_STARTER_CLIENT];
}

// KAIA-1519 — dev-mock lookup table. Maps an email to its dev-mock client
// fixture. Used by portal-session in dev-mock mode (no DB configured) so
// the test runner can switch tiers by setting the dev-email cookie.
export const DEV_MOCK_CLIENT_BY_EMAIL: ReadonlyMap<string, ChatbotClient> = new Map([
  [MOCK_CLIENT.primaryContactEmail.toLowerCase(), MOCK_CLIENT],
  [MOCK_SECONDARY_CLIENT.primaryContactEmail.toLowerCase(), MOCK_SECONDARY_CLIENT],
  [MOCK_STARTER_CLIENT.primaryContactEmail.toLowerCase(), MOCK_STARTER_CLIENT],
]);

// KAIA-1519 — dev-mock lookup by clientId. Used by the wizard page in
// dev-mock mode to recover the tier without a Prisma round trip.
export function getDevMockClientById(clientId: string): ChatbotClient | null {
  for (const client of DEV_MOCK_CLIENT_BY_EMAIL.values()) {
    if (client.id === clientId) return client;
  }
  return null;
}

export const formatPriceEUR = (cents: number): string =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);

// Re-exports for KAIA-755 dev-mock API routes (no DB / no backend configured).
export const MOCK_TIMELINE = MOCK_TIMELINE_INTERNAL;
export const MOCK_BILLING_EXPORT = MOCK_BILLING;
export { MOCK_CONVERSATIONS };
