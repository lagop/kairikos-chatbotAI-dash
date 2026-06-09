import type { Metadata } from 'next';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { PageHeading } from '@/components/portal/PageHeading';
import { getChatbotStatus } from '@/lib/portal-data';
import { assertSameClient, requirePortalSession } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Estado del chatbot',
  description: 'Estado actual, métricas y datos técnicos de tu chatbot Kairikos.',
  alternates: { canonical: '/portal/status' },
  robots: { index: false, follow: false },
};

export default async function StatusPage({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  const session = await requirePortalSession();
  assertSameClient(session, searchParams.client ?? null);
  const summary = await getChatbotStatus(session.accessToken ?? '');
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Chatbot"
        title="Estado del chatbot"
        description="Comprueba el estado actual, los indicadores clave de los últimos 7 días y la información técnica."
      />
      <ChatbotStatusCard summary={summary} />
    </div>
  );
}
