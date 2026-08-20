import type {
  BillingSummary,
  ChatbotClient,
  ChatbotClientUser,
  ChatbotStatusSummary,
  ConversationSummary,
  ConversationTranscript,
  OnboardingTimelineRow,
  SupportLink,
} from '@/types/portal';
import { isBackendConfigured, PORTAL_API_BASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { prisma, isDatabaseConfigured } from './prisma';
import { TIER_LABEL } from './billing-tier';
import { getBillingForClient } from './stripe-billing';
// WP-25 — portal-session.ts imports MOCK_CLIENT / DEV_MOCK_CLIENT_BY_EMAIL
// back from this module, so this is a deliberate circular import. Safe here
// because neither module touches the other's bindings at top-level module
// scope — only inside function bodies, evaluated after the module graph
// finishes loading.
import { resolveClientFromSession } from './portal-session';

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

const ONBOARDING_MILESTONE_STEP: Record<string, { id: OnboardingTimelineRow['step']; label: string }> = {
  'T+0': { id: 't_plus_0', label: 'Bienvenida y acceso al portal' },
  'T+3': { id: 't_plus_3', label: 'Configuración inicial' },
  'T+7': { id: 't_plus_7', label: 'Puesta en producción' },
  'T+14': { id: 't_plus_14', label: 'Revisión y optimización' },
};

// WP-25 (KAIA-13702 follow-up) — this used to depend exclusively on
// portalFetch('/portal/onboarding', ...), which is gated on
// `isBackendConfigured = Boolean(PORTAL_API_BASE_URL)`. Same root cause
// class as listAdminClients() (see the KAIA-13702/13715 comment on
// listAdminClients below): when that gate is false, every real customer
// silently saw the Acme MOCK_TIMELINE_INTERNAL fixture instead of their
// own onboarding timeline, with no error surfaced anywhere. Fix: try
// Prisma first via the same clientId-resolution helper the working
// digest/reviews pages already use (resolveClientFromSession(), see
// portal-session.ts), mirroring the row-mapping logic that already
// lived correctly in GET /api/portal/onboarding (src/app/api/portal/onboarding/route.ts)
// but was unreachable from here. Only fall back to the legacy
// portalFetch path (and from there to the mock) when Prisma is not
// configured, the session doesn't resolve to a real database client, or
// the query itself throws — never because an unrelated env var was unset.
export async function getOnboarding(accessToken: string): Promise<OnboardingTimelineRow[]> {
  if (isDatabaseConfigured) {
    try {
      const resolved = await resolveClientFromSession();
      if (resolved && resolved.source === 'database') {
        const rows = await prisma.chatbotActivity.findMany({
          where: { clientId: resolved.clientId, productCode: 'chatbot' },
          orderBy: { completedAt: 'asc' },
          select: { id: true, milestone: true, completedAt: true, notes: true },
        });
        return rows.map((r): OnboardingTimelineRow => {
          const def = ONBOARDING_MILESTONE_STEP[r.milestone] ?? { id: 't_plus_0' as const, label: r.milestone };
          return {
            id: r.id,
            step: def.id,
            label: def.label,
            description: r.notes ?? '',
            occurredAt: r.completedAt?.toISOString() ?? null,
            status: r.completedAt ? 'done' : 'current',
          };
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[getOnboarding] Prisma read failed, falling back to legacy portalFetch/mocks:', err);
    }
  }
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

// WP-25 follow-up — same root cause as getOnboarding() above (KAIA-11955:
// PORTAL_API_BASE_URL is unset on Vercel production, so portalFetch()
// always returns null and every real customer silently saw the Acme
// MOCK_CONVERSATIONS fixture instead of their own conversations). The
// row-mapping logic mirrors the already-correct GET /api/portal/conversations
// (src/app/api/portal/conversations/route.ts), which was unreachable from
// here via portalFetch. Same fallback contract as getOnboarding(): only
// fall through to legacy portalFetch/mocks when Prisma is not configured,
// the session doesn't resolve to a real database client, or the query throws.
export async function listConversations(accessToken: string): Promise<ConversationSummary[]> {
  if (isDatabaseConfigured) {
    try {
      const resolved = await resolveClientFromSession();
      if (resolved && resolved.source === 'database') {
        const rows = await prisma.chatbotConversation.findMany({
          where: { clientId: resolved.clientId },
          orderBy: { startedAt: 'desc' },
          take: 50,
          select: { id: true, startedAt: true, duration: true, outcome: true },
        });
        return rows.map(
          (r): ConversationSummary => ({
            id: r.id,
            startedAt: r.startedAt.toISOString(),
            durationSeconds: r.duration ?? 0,
            // ChatbotConversation.outcome/no per-row channel column are
            // free-form (see the schema.prisma column comment); the UI
            // (conversations/page.tsx OUTCOME_LABEL/CHANNEL_LABEL) already
            // falls back to the raw string for any value outside the
            // client-facing union, same as the real API route does.
            outcome: (r.outcome ?? 'unknown') as ConversationSummary['outcome'],
            channel: 'other' as ConversationSummary['channel'],
          }),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[listConversations] Prisma read failed, falling back to legacy portalFetch/mocks:', err);
    }
  }
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
  if (isDatabaseConfigured) {
    try {
      const resolved = await resolveClientFromSession();
      if (resolved && resolved.source === 'database') {
        const row = await prisma.chatbotConversation.findFirst({
          where: { id, clientId: resolved.clientId },
          select: { id: true, startedAt: true, duration: true, outcome: true, transcript: true },
        });
        if (!row) return null;
        const transcript = row.transcript as
          | { messages?: Array<{ id?: string; role?: string; content?: string; at?: string }>; channel?: string }
          | null;
        const endedAt = new Date(row.startedAt.getTime() + (row.duration ?? 0) * 1000).toISOString();
        return {
          id: row.id,
          startedAt: row.startedAt.toISOString(),
          endedAt,
          outcome: (row.outcome ?? 'unknown') as ConversationSummary['outcome'],
          channel: (transcript?.channel ?? 'other') as ConversationSummary['channel'],
          messages: (transcript?.messages ?? []).map((m, i) => ({
            id: m.id ?? `m${i}`,
            role: (m.role ?? 'user') as 'user' | 'assistant' | 'system',
            content: m.content ?? '',
            at: m.at ?? row.startedAt.toISOString(),
          })),
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[getConversation] Prisma read failed, falling back to legacy portalFetch/mocks:', err);
    }
  }
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

// WP-25 follow-up — same root cause as getOnboarding()/listConversations()
// above. Reuses getBillingForClient() (src/lib/stripe-billing.ts), the
// exact helper the already-correct GET /api/portal/billing route calls,
// for the Stripe-derived figures (customer portal URL, upcoming invoice —
// summed across all of the client's active subscriptions, matching what
// that route already does). The single "Plan" / "Cuota mensual" the
// billing page renders is projected from ChatbotClient.tier (the
// canonical per-client tier column — see its schema.prisma comment),
// same as MOCK_BILLING was derived from MOCK_CLIENT.tier, since the flat
// BillingSummary shape here predates multi-product billing and this fix
// is scoped to "stop serving Acme's data to real customers", not to
// redesign the page for multiple simultaneous product subscriptions.
export async function getBilling(accessToken: string): Promise<BillingSummary> {
  if (isDatabaseConfigured) {
    try {
      const resolved = await resolveClientFromSession();
      if (resolved && resolved.source === 'database') {
        const [client, summary] = await Promise.all([
          prisma.chatbotClient.findUnique({
            where: { id: resolved.clientId },
            select: { tier: true },
          }),
          getBillingForClient(resolved.clientId),
        ]);
        if (client && summary) {
          const rawTier = client.tier;
          const tier: BillingSummary['tier'] =
            rawTier === 'starter' || rawTier === 'pro' || rawTier === 'premium' ? rawTier : 'starter';
          return {
            tier,
            tierLabel: TIER_LABEL[tier],
            monthlyFeeCents: TIER_PRICE_CENTS[tier],
            currency: 'EUR',
            nextInvoiceDate: summary.upcomingInvoice?.dueAt ?? null,
            nextInvoiceAmountCents: summary.upcomingInvoice?.amountDueCents ?? null,
            stripeCustomerPortalUrl: summary.customer.portalUrl,
            stripeCustomerId: summary.customer.stripeCustomerId,
          };
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[getBilling] Prisma read failed, falling back to legacy portalFetch/mocks:', err);
    }
  }
  const fromApi = await portalFetch<BillingSummary>('/portal/billing', accessToken);
  return fromApi ?? MOCK_BILLING;
}

// Unlike getOnboarding/listConversations/getConversation/getBilling above,
// this one is NOT the same bug class: there is no ChannelSupportLink model,
// no /api/portal/support-link route, and no per-client field to read — the
// support contact (WhatsApp number, business hours) is genuinely the same
// static value for every client, so portalFetch always 404s and falling
// through to MOCK_SUPPORT is the correct, permanent behavior, not a mock
// standing in for missing per-client data.
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
  onboardingStatus: 'in-progress',
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
  onboardingStatus: 'in-progress',
  createdAt: '2026-06-01T09:00:00.000Z',
  goLiveDate: null,
  chatbotSpaceId: null,
};

// KAIA-13702 — listAdminClients() used to go through the local
// `/api/admin/portal/clients` route (which itself proxies to the NestJS
// backend), gated on `isBackendConfigured = Boolean(PORTAL_API_BASE_URL)`.
// That gate is false on Vercel production (`PORTAL_API_BASE_URL` is not in
// the Vercel project env var list), so the page rendered the three
// dev-mock fixtures instead of the real seeded rows (e.g. `clinica dental
// orly`). KAIA-13715 — swapped to a direct Prisma read mirrored after the
// working sibling at `src/app/admin/portal/page.tsx:62`. The original
// KAIA-13702 follow-up kept an `if (!isDatabaseConfigured) return MOCKS`
// guard, and that guard flipped `true` on the `/admin/portal/clients`
// chunk during the Vercel production deploy even though the sibling
// `/admin/portal` chunk evaluated `isDatabaseConfigured` to `true` and
// rendered the 98 real Prisma rows. Root cause hypothesis: a stale
// server-side chunk pinned `process.env.DATABASE_URL` to empty for the
// `listAdminClients()` invocation only. The robust fix below drops the
// gate as the primary path: ALWAYS try Prisma, and only fall back to the
// mocks after the Prisma call itself returns zero rows AND a Prisma-call
// diagnostic log proves the DB was reached. That way:
//   * Local `next dev` with no DB → Prisma throws → fall back to mocks.
//   * Production with DB → Prisma reads real rows → return them, no
//     dependency on the per-chunk `isDatabaseConfigured` evaluation.
// Shape mapping: DB columns are `email` / `state` / `goLiveAt`; the
// `ChatbotClient` type expects `primaryContactEmail` / `onboardingStatus`
// / `goLiveDate`.
//
// WP-23 — this used to validate against a 5-value allowlist that only
// matched 2 of the 5 real values `ChatbotClient.state` can hold (see the
// column comment in schema.prisma and ALLOWED_STATES in
// api/admin/portal/clients/[id]/route.ts for the authoritative list —
// 8 total once the operator-editable pending/paused/cancelled overrides
// are counted). Every unmatched value — 'go-live-pending', 'ready',
// 'updating' among them — silently became 'in_progress', which is the
// exact bug this WP exists to close: a client waiting for go-live
// approval and one whose wizard just regressed after going live were
// indistinguishable from one still filling out the wizard.
//
// ONBOARDING_STATUSES is now the full real set, and an unrecognized value
// is logged as an anomaly instead of silently mapped — the column
// drifting from this list should be loud, not invisible.
// WP-14 — 'archived' / 'draft' added: both were already writable via
// POST /api/internal/clients/[id]/state-transition's ALLOWED_STATES but
// missing here, so they were silently collapsing to 'in-progress' via the
// anomaly fallback below — the same class of bug this list exists to stop.
const ONBOARDING_STATUSES: ReadonlyArray<ChatbotClient['onboardingStatus']> = [
  'pending',
  'in-progress',
  'go-live-pending',
  'ready',
  'live',
  'updating',
  'paused',
  'cancelled',
  'archived',
  'draft',
];

function isKnownOnboardingStatus(value: string): value is ChatbotClient['onboardingStatus'] {
  return (ONBOARDING_STATUSES as readonly string[]).includes(value);
}

function toOnboardingStatus(value: string | null | undefined): ChatbotClient['onboardingStatus'] {
  const raw = value ?? 'in-progress';
  if (isKnownOnboardingStatus(raw)) {
    return raw;
  }
  // eslint-disable-next-line no-console
  console.error(
    `[toOnboardingStatus] anomaly: ChatbotClient.state has unrecognized value ${JSON.stringify(raw)} — ` +
      `not in the known list (${ONBOARDING_STATUSES.join(', ')}). Falling back to 'in-progress'. ` +
      'This means the column has drifted from types/portal.ts OnboardingStatus.',
  );
  return 'in-progress';
}

// KAIA-13715 — single-shot diagnostic so a future Vercel production
// regression surfaces in the function logs without a code-bisect. The
// helper emits ONE line per cold invocation. The fields are deliberately
// the ones QA needs to confirm (a) the function ran at all, (b) the env
// resolved at this chunk, (c) whether Prisma was asked to read.
function logListAdminClientsDiag(args: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.log('[listAdminClients] DEBUG', JSON.stringify(args));
  } catch {
    // never throw from a debug log
  }
}

export async function listAdminClients(search?: string | null): Promise<ChatbotClient[]> {
  const trimmed = (search ?? '').trim();
  const diag = {
    isDatabaseConfigured,
    rawDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasPrisma: typeof prisma !== 'undefined' && Boolean(prisma),
    searched: trimmed.length > 0,
  };

  // KAIA-13715 — try Prisma first. The early-return guard against
  // `!isDatabaseConfigured` was unreliable on Vercel production where
  // the same env var evaluated truthy on a sibling route but falsy on
  // this one (likely a stale server-side chunk). Letting Prisma try the
  // actual query eliminates that entire class of bug: if the DB is
  // reachable, it answers; if it's not, we catch and fall back to the
  // mocks. We only consult `isDatabaseConfigured` as an observability
  // hint in the diag log — never as a function-short-circuit gate.
  try {
    const dbRows = await prisma.chatbotClient.findMany({
      orderBy: { createdAt: 'desc' },
      where: trimmed
        ? {
            OR: [
              { companyName: { contains: trimmed, mode: 'insensitive' } },
              { email: { contains: trimmed, mode: 'insensitive' } },
            ],
          }
        : undefined,
      select: {
        id: true,
        companyName: true,
        name: true,
        email: true,
        tier: true,
        stripeCustomerId: true,
        state: true,
        goLiveAt: true,
        createdAt: true,
      },
    });
    logListAdminClientsDiag({ ...diag, prismaReadOk: true, rowCount: dbRows.length });
    if (dbRows.length > 0) {
      return dbRows.map((r): ChatbotClient => {
        const companyName = r.companyName ?? r.name;
        // KAIA-13114 — schema has no slug column; expose the cuid id as the
        // slug-shaped display value the AdminClientsPage expects. The id is
        // unique and stable, and the page only renders it under the
        // company name — it never builds a /c/<slug> link against it.
        return {
          id: r.id,
          slug: r.id,
          companyName,
          primaryContactEmail: r.email,
          stripeCustomerId: r.stripeCustomerId ?? null,
          tier: (r.tier as ChatbotClient['tier']) ?? 'starter',
          onboardingStatus: toOnboardingStatus(r.state),
          createdAt: r.createdAt.toISOString(),
          goLiveDate: r.goLiveAt ? r.goLiveAt.toISOString() : null,
          // KAIA-13114 — schema has no chatbotSpaceId column on
          // ChatbotClient; the operator clients view does not render it,
          // but the ChatbotClient type requires the field. Surface null
          // until a follow-up wires the Supabase space id here.
          chatbotSpaceId: null,
        };
      });
    }
    // Prisma reached the DB and the query succeeded — but returned zero
    // rows. That's a legitimate real state (empty tenant list), NOT a
    // signal to render mocks. Surface [] so the page renders the
    // existing "Sin clientes" empty state.
    return [];
  } catch (err) {
    logListAdminClientsDiag({
      ...diag,
      prismaReadOk: false,
      errorName: err instanceof Error ? err.name : 'unknown',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // KAIA-1519 — dev-mock fallback ONLY when Prisma is genuinely
    // unreachable. Mirror the page-sibling contract at
    // `src/app/admin/portal/page.tsx:62`: local `next dev` with no DB
    // falls back to the three fixtures; everything else surfaces [].
    if (!isDatabaseConfigured) {
      return [MOCK_CLIENT, MOCK_SECONDARY_CLIENT, MOCK_STARTER_CLIENT];
    }
    return [];
  }
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
