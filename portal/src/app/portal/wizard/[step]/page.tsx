import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession, isPortalDevMock } from '@/lib/portal-session';
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
  type WizardStepNumber,
  type WizardTier,
} from '@/lib/wizard-catalog';
import { readWizardStep } from '@/lib/wizard-client';
import { jsonToObject } from '@/lib/wizard-tier-prisma';
import { WizardStepShell } from '@/components/portal/WizardStepShell';
import { getDevMockClientById } from '@/lib/portal-data';

interface PageProps {
  params: { step: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
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
    alternates: { canonical: `/portal/wizard/${def.key}` },
    robots: { index: false, follow: false },
  };
}

export default async function WizardStepPage({ params }: PageProps) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect(`/portal/login?next=/portal/wizard/${encodeURIComponent(params.step)}`);
  }

  let stepNumber: WizardStepNumber;
  try {
    stepNumber = parseStepNumber(params.step);
  } catch {
    notFound();
  }

  const def = getStepDefinition(stepNumber);

  if (!isDatabaseConfigured || isPortalDevMock()) {
    // KAIA-1519 — keep all 12 catalog entries (including Step 12) so the
    // v11Deferred "Próximamente" notice can render for direct visits to
    // `/portal/wizard/12`. The step list itself filters Step 12 out so it
    // never appears in the block-progress nav.
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

  const [client, savedRows] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tier: true },
    }),
    readLatestStepsForClient(prisma, resolved.clientId),
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

  const result = await readWizardStep(prisma, resolved.clientId, params.step);
  const latestPayload = jsonToObject(
    (result?.latest?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
  );
  const activePayload = jsonToObject(
    (result?.active?.payload as Parameters<typeof jsonToObject>[0]) ?? null,
  );
  const savedPayload = latestPayload ?? activePayload;
  const hasSaved = !!result?.latest;

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

  return (
    <WizardStepShell
      stepNumber={def.number}
      stepKey={def.key}
      stepLabel={def.label}
      block={def.block}
      visibleForTier={stepVisible}
      autoConfigured={resolvedStep.autoConfigured}
      v11Deferred={def.v11Deferred}
      effectivePayload={resolvedStep.effectivePayload}
      savedPayload={resolvedStep.savedPayload}
      saved={{
        hasSavedVersion: hasSaved,
        status: result?.latest?.status,
        submittedAt: result?.latest?.submittedAt?.toISOString() ?? null,
        approvedAt: result?.latest?.approvedAt?.toISOString() ?? null,
        activeForBot: result?.latest?.activeForBot,
        seededFromIntake: result?.latest?.seededFromIntake,
      }}
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
