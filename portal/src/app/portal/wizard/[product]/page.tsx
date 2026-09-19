import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { readLatestStepsForClient } from '@/lib/wizard-tier-prisma';
import { listStepsForClient, buildSavedStateMap } from '@/lib/wizard-visibility';
import { parseStepNumber, CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { PRODUCT_CODES } from '@/lib/catalogs';
import { isProductContracted, resolveContractedInstance } from '@/lib/client-product-access';
import { withChatbot } from '@/lib/wizard-url';

// =============================================================================
// WP-16 — per-product wizard entry point. Resolves the first visible step
// for this product + tier and redirects there. Mirrors the pre-WP-16
// /portal/wizard/page.tsx (which is now the multi-product selector — see
// that file).
// =============================================================================

export const dynamic = 'force-dynamic';

export default async function WizardProductIndexPage({
  params,
  searchParams,
}: {
  params: { product: string };
  /** clientProductId: Fase 4 multi-instancia, solo con varios chatbots. */
  searchParams: { step?: string; clientProductId?: string };
}) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect(`/portal/login?next=${encodeURIComponent(`/portal/wizard/${params.product}`)}`);
  }

  if (!(PRODUCT_CODES as readonly string[]).includes(params.product)) {
    notFound();
  }

  // Se propaga el chatbot que llegó; sin él (un solo chatbot) las URLs son
  // las de siempre. Ver lib/wizard-url.ts.
  const incomingChatbotId = searchParams.clientProductId ?? null;

  const queryStep = searchParams.step;
  if (queryStep) {
    try {
      parseStepNumber(queryStep);
      redirect(withChatbot(`/portal/wizard/${params.product}/${queryStep}`, incomingChatbotId));
    } catch {
      redirect(withChatbot(`/portal/wizard/${params.product}`, incomingChatbotId));
    }
  }

  // See the matching comment in wizard/[product]/[step]/page.tsx —
  // resolved.source === 'database' means this is a real, authenticated
  // client, which must take priority over the isPortalDevMock() heuristic.
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    if (params.product !== CHATBOT_PRODUCT_CODE) notFound();
    redirect(`/portal/wizard/${CHATBOT_PRODUCT_CODE}/1`);
  }

  const contracted = await isProductContracted(prisma, resolved.clientId, params.product);
  if (!contracted) {
    redirect('/portal/wizard');
  }

  if (params.product !== CHATBOT_PRODUCT_CODE) {
    // Contracted but no wizard content yet — nothing to redirect to.
    notFound();
  }

  // Fase 4 multi-instancia — de QUÉ chatbot. Con varios y sin decir cuál,
  // al índice, que ofrece elegir.
  const chatbot = await resolveContractedInstance(prisma, {
    clientId: resolved.clientId,
    productCode: params.product,
    clientProductId: incomingChatbotId,
  });
  if (!chatbot) {
    redirect('/portal/wizard');
  }

  const [client, savedRows] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tier: true },
    }),
    readLatestStepsForClient(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE, chatbot.clientProductId),
  ]);

  // La tarifa de ESTE chatbot decide cuál es el primer paso visible.
  const tier = chatbot.tier ?? client?.tier ?? 'starter';
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

  redirect(withChatbot(`/portal/wizard/${CHATBOT_PRODUCT_CODE}/${firstVisible?.key ?? '1'}`, incomingChatbotId));
}
