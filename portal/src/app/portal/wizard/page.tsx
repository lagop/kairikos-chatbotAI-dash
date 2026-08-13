import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession, isPortalDevMock } from '@/lib/portal-session';
import { readLatestStepsForClient } from '@/lib/wizard-tier-prisma';
import { listStepsForClient, buildSavedStateMap } from '@/lib/wizard-visibility';
import { parseStepNumber, CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';

export const dynamic = 'force-dynamic';

export default async function WizardIndexPage({
  searchParams,
}: {
  searchParams: { step?: string };
}) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/wizard');
  }

  const queryStep = searchParams.step;
  if (queryStep) {
    try {
      parseStepNumber(queryStep);
      redirect(`/portal/wizard/${queryStep}`);
    } catch {
      redirect('/portal/wizard');
    }
  }

  if (!isDatabaseConfigured || isPortalDevMock()) {
    redirect('/portal/wizard/1');
  }

  const [client, savedRows] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tier: true },
    }),
    readLatestStepsForClient(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE),
  ]);

  const tier = client?.tier ?? 'starter';
  const savedMap = buildSavedStateMap(
    savedRows.map((r) => ({
      stepKey: r.stepKey,
      latest: r.latest
        ? {
            status: r.latest.status,
            submittedAt: r.latest.submittedAt?.toISOString() ?? null,
            approvedAt: r.latest.approvedAt?.toISOString() ?? null,
            activeForBot: r.latest.activeForBot,
          }
        : null,
    })),
  );

  const { steps } = listStepsForClient(tier as 'starter' | 'pro' | 'premium', savedMap);
  const firstVisible = steps.find((s) => s.visible && !s.v11Deferred);

  if (firstVisible) {
    redirect(`/portal/wizard/${firstVisible.key}`);
  }

  redirect('/portal/wizard/1');
}
