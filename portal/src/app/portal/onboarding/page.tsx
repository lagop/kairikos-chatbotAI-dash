import type { Metadata } from 'next';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { getOnboardingFor } from '@/lib/portal-data';
import { assertSameClient, requirePortalSession } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Onboarding',
  description: 'Línea de tiempo completa del onboarding de tu chatbot Kairikos.',
  alternates: { canonical: '/portal/onboarding' },
  robots: { index: false, follow: false },
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  const session = await requirePortalSession();
  assertSameClient(session, searchParams.client ?? null);
  const rows = await getOnboardingFor(session.accessToken ?? '', searchParams.client ?? null);
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Onboarding"
        title="Tu proceso de onboarding"
        description="Te explicamos cada paso que seguimos para poner en marcha tu chatbot y lo que viene después."
      />
      <section className="card" aria-label="Línea de tiempo del onboarding">
        <OnboardingTimeline rows={rows} />
      </section>
    </div>
  );
}