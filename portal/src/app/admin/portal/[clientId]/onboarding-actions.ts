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
// `(clientId, productCode, milestone)` key (WP-14; was `(clientId,
// milestone)`) guarantees a re-click on the same milestone is a no-op-ish
// (the row already exists, `completedAt` is re-stamped to `now()`).
//
// WP-18 — the operator can now advance the milestone timeline for any
// product the client has (not just chatbot). `productCode` is read from
// the same FormData the milestone comes from and validated against the
// product catalog registry, mirroring `isAllowedMilestone`'s shape.
//
// KAIA-14409 — write goes through the regular pooled `prisma` client. The
// earlier direct-connection split (KAIA-14388) was inert on prod because
// Supabase's true direct host is IPv6-only and Vercel has no IPv6 egress.
// The pooled client demonstrably returns the T+0 row at
// `/api/admin/portal/flows`, so we trust it for the matching read path
// too. See KAIA-14409 comment `3510e67a` for the full diagnosis.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { isAllowedMilestone } from './onboarding-constants';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { PRODUCT_CODES, type ProductCode } from '@/lib/catalogs';

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

export async function advanceOnboardingMilestone(
  formData: FormData,
): Promise<void> {
  const clientId = formData.get('clientId');
  const milestone = formData.get('milestone');
  const productCodeRaw = formData.get('productCode');
  const productCode = typeof productCodeRaw === 'string' && isProductCode(productCodeRaw)
    ? productCodeRaw
    : CHATBOT_PRODUCT_CODE;

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
    select: { id: true, tenantId: true },
  });
  if (!client) {
    return;
  }

  const now = new Date();
  const note = `Marcado por el operador (${session.email ?? 'operador'}) el ${now.toISOString()}`;
  await prisma.chatbotActivity.upsert({
    where: {
      clientId_productCode_milestone: {
        clientId,
        productCode,
        milestone,
      },
    },
    create: {
      clientId,
      tenantId: client.tenantId,
      productCode,
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
  revalidatePath(`/portal`);
  if (productCode === CHATBOT_PRODUCT_CODE) {
    revalidatePath(`/portal/onboarding`);
  }
}
