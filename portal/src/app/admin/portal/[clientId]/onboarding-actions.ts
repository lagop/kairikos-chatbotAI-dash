'use server';

// =============================================================================
// KAIA-14345 — operator-side onboarding advance controls.
//
// The fix for KAIA-14318 (`c97a0e9` / `70fc903`) replaced the default
// initializer on `/admin/portal/[clientId]` with an empty-state copy, but
// the empty-state is a dead-end for operators: a brand-new client has no
// `chatbotActivity` rows, so the Onboarding module shows "Aún no hay
// pasos registrados" with no way to create the first row. The setup work
// for the operator (kick T+0, then T+3, then T+7) has to happen from
// the operator admin UI.
//
// `advanceOnboardingMilestone` is the operator's hand to advance the
// on-boarding timeline. It writes directly to the `chatbotActivity`
// table (the same table the client-side `handleAssetsUploaded` already
// mutates from `/api/portal/onboarding/*`) and revalidates the page so
// the OnboardingTimeline re-renders without a manual refresh. Auth is
// gated on `session.isOperator` so a non-operator session that somehow
// reaches the form still gets a 403 (and never touches the DB).
//
// We deliberately do NOT add a new HTTP endpoint — the page is already a
// server component, and the operator session is the same `getSession()`
// resolution that the page uses for its own auth gate. This mirrors the
// pattern in `/api/admin/portal/wizard/[clientId]/[step]` (the BE-4
// endpoint) but skips the round-trip: the form action handler is the
// auth check.
//
// Idempotency: `chatbotActivity.upsert` on the unique
// `(clientId, milestone)` key guarantees a re-click on the same milestone
// is a no-op-ish (the row already exists, `completedAt` is re-stamped
// to `now()`).
// =============================================================================

import { revalidatePath } from 'next/cache';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { isAllowedMilestone } from './onboarding-constants';

export async function advanceOnboardingMilestone(
  formData: FormData,
): Promise<void> {
  const clientId = formData.get('clientId');
  const milestone = formData.get('milestone');

  if (typeof clientId !== 'string' || !clientId) {
    return;
  }
  if (typeof milestone !== 'string' || !isAllowedMilestone(milestone)) {
    return;
  }

  const session = await getSession();
  if (!session.isOperator) {
    return;
  }
  if (!isDatabaseConfigured) {
    return;
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) {
    return;
  }

  const now = new Date();
  const note = `Marcado por el operador (${session.email ?? 'operador'}) el ${now.toISOString()}`;
  await prisma.chatbotActivity.upsert({
    where: { clientId_milestone: { clientId, milestone } },
    create: {
      clientId,
      milestone,
      completedAt: now,
      notes: note,
    },
    update: {
      completedAt: now,
      notes: note,
    },
    select: { id: true },
  });

  revalidatePath(`/admin/portal/${clientId}`);
  revalidatePath(`/portal/onboarding`);
}
