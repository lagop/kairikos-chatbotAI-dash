import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { readLatestStepsForClient } from '@/lib/wizard-tier-prisma';
import {
  listStepsForClient,
  buildSavedStateMap,
  resolveClientStep,
} from '@/lib/wizard-visibility';
import {
  parseStepNumber,
  getStepDefinition,
  normalizeTier,
  WIZARD_STEP_CATALOG,
  CHATBOT_PRODUCT_CODE,
  type WizardStepNumber,
  type WizardTier,
} from '@/lib/wizard-catalog';
import { PRODUCT_CODES } from '@/lib/catalogs';
import { isProductContracted } from '@/lib/client-product-access';
import { readWizardStep } from '@/lib/wizard-client';
import { jsonToObject } from '@/lib/wizard-tier-prisma';
import { getCrossProductSeed } from '@/lib/cross-product-seed';
import { WizardStepShell } from '@/components/portal/WizardStepShell';
import { getDevMockClientById } from '@/lib/portal-data';

// =============================================================================
// WP-16 — product-scoped wizard step page. Adapted from the pre-WP-16
// /portal/wizard/[step]/page.tsx (now a redirect shim — see that file).
//
// Only 'chatbot' has real step content today (see the API route's header
// comment for the full rationale); this page's `product` gate exists so
// the URL can't be used to reach a wizard that doesn't exist yet, or one
// the client never bought.
// =============================================================================

interface PageProps {
  params: { product: string; step: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  if (params.product !== CHATBOT_PRODUCT_CODE) {
    return {
      title: 'Configurar producto · Kairikos',
      robots: { index: false, follow: false },
    };
  }
  const stepNumber = tryParseStep(params.step);
  if (stepNumber === null) {
    return {
      title: 'Configurar chatbot · Kairikos',
      description: 'Asistente de configuración de tu chatbot Kairikos.',
      robots: { index: false, follow: false },
    };
  }
  const def = getStepDefinition(stepNumber);
  return {
    title: `${def.label} · Configurar chatbot · Kairikos`,
    description: `Paso ${def.number}: ${def.label}. Configura tu chatbot Kairikos.`,
    alternates: { canonical: `/portal/wizard/${CHATBOT_PRODUCT_CODE}/${def.key}` },
    robots: { index: false, follow: false },
  };
}

export default async function WizardStepPage({ params }: PageProps) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect(
      `/portal/login?next=${encodeURIComponent(`/portal/wizard/${params.product}/${params.step}`)}`,
    );
  }

  if (!(PRODUCT_CODES as readonly string[]).includes(params.product)) {
    notFound();
  }

  // `resolved.source === 'database'` means resolveClientFromSession()
  // already matched a real, authenticated NextAuth session to a real
  // ChatbotClientUser row — that takes priority over isPortalDevMock(),
  // same as it does inside resolveClientFromSession() itself. Gating this
  // branch on isPortalDevMock() alone (a Supabase-env-var heuristic,
  // unrelated to whether a real session exists) reintroduces the exact
  // bug documented in portal-session.ts and session.ts: any environment
  // with a real DATABASE_URL but placeholder Supabase vars (ordinary
  // local dev, since portal auth is NextAuth Credentials now, not
  // Supabase) would silently route a real client into the dev-mock
  // fixture branch below — which forces isDatabaseConfigured={false} and
  // null payloads onto the shell, breaking every save for that client.
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    // Dev-mock fixtures (src/lib/portal-data.ts) are chatbot-only — there
    // is no ClientProduct concept in dev-mock mode, so any other product
    // code has nothing to render.
    if (params.product !== CHATBOT_PRODUCT_CODE) notFound();

    let stepNumber: WizardStepNumber;
    try {
      stepNumber = parseStepNumber(params.step);
    } catch {
      notFound();
    }
    const def = getStepDefinition(stepNumber);

    // KAIA-1519 — keep all 12 catalog entries (including Step 12) so the
    // v11Deferred "Próximamente" notice can render for direct visits to
    // `/portal/wizard/chatbot/12`. The step list itself filters Step 12
    // out so it never appears in the block-progress nav.
    const allCatalogSteps = Object.values(WIZARD_STEP_CATALOG);
    const mockStep = allCatalogSteps.find((s) => s.number === stepNumber);
    if (!mockStep) notFound();

    // KAIA-1519 — dev-mock tier recovery. The default MOCK_CLIENT is
    // tier=pro, so before this fix every dev-mock session hardcoded
    // Steps 3 + 7 as auto-configured regardless of the actual tier. Now
    // we look up the resolved clientId in the dev-mock fixtures and use
    // its real tier to compute visibility, so a Starter dev-mock session
    // sees the Starter matrix (Steps 3 + 7 hidden) and a Pro session
    // sees the full 11-step editable list.
    const devMockClient = getDevMockClientById(resolved.clientId);
    const mockTier: WizardTier | null = normalizeTier(devMockClient?.tier ?? null);

    // Block progress only lists non-v11Deferred steps.
    const mockList = allCatalogSteps.map((s) => ({
      number: s.number,
      key: s.key,
      label: s.label,
      block: s.block,
      requiredForReady: s.requiredForReady,
      visible: s.visibleFor(mockTier) && !s.v11Deferred,
      autoConfigured: !s.visibleFor(mockTier),
      v11Deferred: s.v11Deferred,
    }));
    const stepVisibleForTier = def.visibleFor(mockTier);
    return (
      <WizardStepShell
        productCode={CHATBOT_PRODUCT_CODE}
        stepNumber={def.number}
        stepKey={def.key}
        stepLabel={def.label}
        block={def.block}
        visibleForTier={stepVisibleForTier}
        autoConfigured={!stepVisibleForTier}
        v11Deferred={def.v11Deferred}
        // KAIA-1519 — for visible steps in dev-mock we want the per-step
        // form components' built-in defaults to kick in (each component
        // has a `value ?? defaults` merge). Passing `null` instead of
        // `def.defaultPayload` (which is `{}` for non-hidden steps) lets
        // the component treat this as "no saved data yet" and seed its
        // own array/struct defaults (idiomas, servicios, etc.).
        // For hidden steps we keep the catalog default so the form can
        // render the "auto-configured" notice with the bot-ready
        // payload.
        effectivePayload={stepVisibleForTier ? null : def.defaultPayload}
        savedPayload={null}
        saved={{ hasSavedVersion: false }}
        isDatabaseConfigured={false}
        steps={mockList}
      />
    );
  }

  const contracted = await isProductContracted(prisma, resolved.clientId, params.product);
  if (!contracted) {
    // A known product the client hasn't bought — send them to the
    // selector so they see what they actually have, rather than a bare
    // 403/404 dead end.
    redirect('/portal/wizard');
  }

  if (params.product !== CHATBOT_PRODUCT_CODE) {
    // Real, contracted product with no wizard content yet (WP-15's
    // registry has it as an empty catalog).
    notFound();
  }

  let stepNumber: WizardStepNumber;
  try {
    stepNumber = parseStepNumber(params.step);
  } catch {
    notFound();
  }

  const def = getStepDefinition(stepNumber);

  const [client, savedRows] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tier: true },
    }),
    readLatestStepsForClient(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE),
  ]);

  const tier = normalizeTier(client?.tier ?? null);
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

  const { steps } = listStepsForClient(tier, savedMap);

  const stepVisible = def.visibleFor(tier);
  if (!stepVisible) {
    const resolvedStep = resolveClientStep(stepNumber, tier, { hasSavedVersion: false }, null);
    return (
      <WizardStepShell
        productCode={CHATBOT_PRODUCT_CODE}
        stepNumber={def.number}
        stepKey={def.key}
        stepLabel={def.label}
        block={def.block}
        visibleForTier={false}
        autoConfigured={true}
        v11Deferred={def.v11Deferred}
        effectivePayload={resolvedStep.effectivePayload}
        savedPayload={null}
        saved={{ hasSavedVersion: false }}
        isDatabaseConfigured={true}
        steps={steps}
      />
    );
  }

  const result = await readWizardStep(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE, params.step);
  const latestPayload = jsonToObject(
    (result?.latest?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
  );
  const activePayload = jsonToObject(
    (result?.active?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
  );
  const savedPayload = latestPayload ?? activePayload;
  const hasSaved = !!result?.latest;

  // WP-29 — the client already answered this elsewhere. Only relevant
  // when this step has no saved version of its own yet: the moment the
  // client saves any version (even from the pre-filled inherited values
  // below), `savedPayload` above stops being null and always wins, which
  // is the entire mechanism behind "this product keeps its own copy from
  // the moment it's touched".
  const inheritedSeed = hasSaved
    ? null
    : await getCrossProductSeed(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE, params.step);

  const resolvedStep = resolveClientStep(
    stepNumber,
    tier,
    {
      hasSavedVersion: hasSaved,
      status: result?.latest?.status,
      submittedAt: result?.latest?.submittedAt?.toISOString() ?? null,
      approvedAt: result?.latest?.approvedAt?.toISOString() ?? null,
      activeForBot: result?.latest?.activeForBot,
    },
    savedPayload,
  );

  const effectivePayload = inheritedSeed?.inheritedFrom.length
    ? { ...resolvedStep.effectivePayload, ...inheritedSeed.payload }
    : resolvedStep.effectivePayload;

  return (
    <WizardStepShell
      productCode={CHATBOT_PRODUCT_CODE}
      stepNumber={def.number}
      stepKey={def.key}
      stepLabel={def.label}
      block={def.block}
      visibleForTier={stepVisible}
      autoConfigured={resolvedStep.autoConfigured}
      v11Deferred={def.v11Deferred}
      effectivePayload={effectivePayload}
      savedPayload={resolvedStep.savedPayload}
      saved={{
        hasSavedVersion: hasSaved,
        status: result?.latest?.status,
        submittedAt: result?.latest?.submittedAt?.toISOString() ?? null,
        approvedAt: result?.latest?.approvedAt?.toISOString() ?? null,
        activeForBot: result?.latest?.activeForBot,
        seededFromIntake: result?.latest?.seededFromIntake,
      }}
      inheritedFrom={inheritedSeed?.inheritedFrom ?? []}
      isDatabaseConfigured={true}
      steps={steps}
    />
  );
}

function tryParseStep(raw: string): WizardStepNumber | null {
  try {
    return parseStepNumber(raw);
  } catch {
    return null;
  }
}
