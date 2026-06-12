import type { Metadata } from 'next';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { SelfServiceActions } from '@/components/portal/SelfServiceActions';
import { getOnboardingFor } from '@/lib/portal-data';
import { assertSameClient, requirePortalSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';

export const metadata: Metadata = {
  title: 'Onboarding',
  description: 'Línea de tiempo completa del onboarding de tu chatbot Kairikos.',
  alternates: { canonical: '/portal/onboarding' },
  robots: { index: false, follow: false },
};

const MILESTONE_LABEL: Record<string, 'T+0' | 'T+3' | 'T+7' | 'T+14'> = {
  t_plus_0: 'T+0',
  t_plus_3: 'T+3',
  t_plus_7: 'T+7',
  t_plus_14: 'T+14',
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  const session = await requirePortalSession();
  assertSameClient(session, searchParams.client ?? null);
  const rows = await getOnboardingFor(session.accessToken ?? '', searchParams.client ?? null);

  // Derive server-side: which milestone is "active" and whether
  // go-live-ready should be enabled. The server is the source of truth
  // for the state machine; the client component only renders buttons
  // it has been told to render.
  const activeRow = rows.find((r) => r.status === 'current');
  const doneCount = rows.filter((r) => r.status === 'done').length;
  const totalCount = rows.length;
  const activeMilestoneId = activeRow ? MILESTONE_LABEL[activeRow.step] : null;
  const canMarkAssetsUploaded = activeMilestoneId === 'T+3';
  const canGoLiveReady = await computeCanGoLiveReady(
    session,
    activeMilestoneId,
    doneCount,
    totalCount,
  );

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
      <SelfServiceActions
        activeMilestoneId={activeMilestoneId}
        canGoLiveReady={canGoLiveReady}
        canMarkAssetsUploaded={canMarkAssetsUploaded}
        variant="onboarding"
        clientId={session.clientId ?? ''}
        revalidatePath="/portal/onboarding"
      />
    </div>
  );
}

/**
 * Server-side check: can the client request go-live right now?
 *
 *   * Dev-mock mode: only the mock client (which always has all
 *     milestones "done" in the seed) qualifies.
 *   * Database mode: requires `ChatbotClient.state = 'in-progress'`,
 *     no `goLiveAt`, and T+0 / T+3 / T+7 all completed. The same
 *     preconditions are enforced server-side by the POST handler so
 *     the UI cannot bypass the state machine.
 */
async function computeCanGoLiveReady(
  session: { hasClientAccess: boolean; clientId: string | null; accessToken: string | null },
  activeMilestoneId: 'T+0' | 'T+3' | 'T+7' | 'T+14' | null,
  doneCount: number,
  totalCount: number,
): Promise<boolean> {
  if (!session.hasClientAccess || !session.clientId) return false;
  // The mock client is the only one whose seed timeline has every
  // milestone "done". Until we wire real data, this is the only case
  // the button can light up.
  const isMock = session.accessToken === 'dev-mock';
  if (isMock) {
    return totalCount > 0 && doneCount >= Math.max(0, totalCount - 1);
  }
  if (isDatabaseConfigured) {
    const resolved = await resolveClientFromSession();
    if (!resolved) return false;
    const client = await prisma.chatbotClient.findUnique({
      where: { id: session.clientId },
      select: { state: true, goLiveAt: true },
    });
    if (!client) return false;
    if (client.goLiveAt) return false;
    if (client.state !== 'in-progress') return false;
    return activeMilestoneId === 'T+14';
  }
  return false;
}
