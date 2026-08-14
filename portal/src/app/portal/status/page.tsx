import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { PageHeading } from '@/components/portal/PageHeading';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getDashboardData } from '@/lib/dashboard-data';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { logError } from '@/lib/observability';
import type { OnboardingStatus } from '@/types/portal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Estado del chatbot',
  description: 'Estado actual, métricas y datos técnicos de tu chatbot Kairikos.',
  alternates: { canonical: '/portal/status' },
  robots: { index: false, follow: false },
};

// =============================================================================
// WP-17 — this page used to call getChatbotStatus(accessToken), a
// self-fetch to /api/portal/status that fell back to the MOCK_CHATBOT
// fixture (8% fallback, 12% escalation) on any failure. That's the exact
// shape of the CONFIRMADO audit finding: this page showed 8%/12% for a
// real client with zero conversations while /portal showed 0%/0% for the
// same client at the same moment — two independent computations that had
// already drifted. Now both pages render whatever getDashboardData()
// (dashboard-data.ts) decided, same as /portal — nothing here recomputes
// the rates.
// =============================================================================
export default async function StatusPage() {
  let session;
  try {
    session = await getSession();
  } catch (err) {
    logError('portal_status.get_session', err, { route: '/portal/status' });
    redirect('/portal/login');
  }
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/sin-acceso');
  }

  const data = await getDashboardData(resolved);
  const chatbot = data.products.find((p) => p.productCode === CHATBOT_PRODUCT_CODE);

  if (!chatbot) {
    return (
      <div className="space-y-6">
        <PageHeading
          eyebrow="Chatbot"
          title="Estado del chatbot"
          description="Comprueba el estado actual, los indicadores clave de los últimos 7 días y la información técnica."
        />
        <div className="card text-sm text-kairikos-muted">
          No tienes el producto Chatbot contratado en esta cuenta.
        </div>
      </div>
    );
  }

  const summary = {
    spaceId: `spc_${data.client.id}`,
    status: chatbot.onboardingState as OnboardingStatus,
    goLiveDate: chatbot.goLiveAt,
    last7Days: chatbot.activity?.last7Days ?? { conversations: 0, fallbackRate: 0, escalationRate: 0 },
  };

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Chatbot"
        title="Estado del chatbot"
        description="Comprueba el estado actual, los indicadores clave de los últimos 7 días y la información técnica."
      />
      <ChatbotStatusCard summary={summary} previous7Days={chatbot.activity?.previous7Days} />
    </div>
  );
}
