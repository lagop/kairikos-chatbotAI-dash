// =============================================================================
// KAIA-1166 — Smoke test for the BE-4 tier-aware wizard service layer.
//
//   GET /api/portal/wizard/steps            (cliente)
//   GET /api/portal/wizard/step/[number]    (cliente)
//   GET /api/admin/portal/wizard/[clientId]/steps           (operator)
//   GET /api/admin/portal/wizard/[clientId]/step/[number]  (operator)
//
// Mirrors the production code in:
//   * src/lib/wizard-tier.ts         (pure visibility + resolution — no DB)
//   * src/lib/wizard-tier-service.ts (DB-backed composition)
//   * src/app/api/portal/wizard/steps/route.ts
//   * src/app/api/portal/wizard/step/[number]/route.ts
//   * src/app/api/admin/portal/wizard/[clientId]/steps/route.ts
//   * src/app/api/admin/portal/wizard/[clientId]/step/[number]/route.ts
//
// This smoke is a self-contained in-process composition test: it stubs
// an in-memory `FakePrisma` and exercises the pure visibility logic from
// `wizard-tier.ts` exactly as the production service does. We inline the
// service glue (read tier + read saved step + compose response) so the
// script does not pull in `server-only` (Next.js / Edge runtime guard)
// and can run under plain `tsx` without a Next.js build step.
//
// The route handlers themselves are thin wrappers (auth + JSON shaping);
// auth is covered by the existing BE-2/BE-3 Playwright tests, so the
// smoke focuses on the service contract.
//
// Run:   npx tsx scripts/smoke-wizard-tier.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { randomUUID } from 'node:crypto';
import {
  WIZARD_STEP_NUMBERS,
  isOperatorVisible,
  isVisibleForTier,
  listStepsForClient,
  listStepsForOperator,
  normaliseTier,
  resolveClientStep,
  resolveOperatorStep,
  getCatalogEntryByNumber,
  type Tier,
  type WizardStepNumber,
} from '../src/lib/wizard-tier';

// -----------------------------------------------------------------------------
// Test harness.
// -----------------------------------------------------------------------------

let assertionCount = 0;
let failureCount = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  assertionCount += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failureCount += 1;
    console.error(`FAIL  ${label}\n  expected: ${e}\n  actual:   ${a}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

function assertTrue(label: string, cond: boolean, detail?: string): void {
  assertionCount += 1;
  if (!cond) {
    failureCount += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

// -----------------------------------------------------------------------------
// In-memory Prisma stand-in + service glue (mirrors wizard-tier-service.ts).
// -----------------------------------------------------------------------------

interface FakeConfigStepRow {
  id: string;
  clientId: string;
  stepKey: string;
  version: number;
  status: string;
  payload: Record<string, unknown> | null;
  activeForBot: boolean;
}

interface FakeClientRow {
  id: string;
  tier: Tier;
}

const fakeClients = new Map<string, FakeClientRow>();
const fakeSteps: FakeConfigStepRow[] = [];

function makeFakePrisma() {
  return {
    chatbotClient: {
      async findUnique({ where, select }: { where: { id: string }; select?: { tier?: boolean } }) {
        const row = fakeClients.get(where.id);
        if (!row) return null;
        if (select && Object.keys(select).length === 0) return { id: row.id };
        return { id: row.id, tier: row.tier };
      },
    },
    chatbotConfigStep: {
      async findFirst({
        where,
        orderBy,
      }: {
        where: { clientId: string; stepKey?: string; activeForBot?: boolean };
        orderBy?: { version: 'asc' | 'desc' };
      }) {
        let rows = fakeSteps.filter((r) => r.clientId === where.clientId);
        if (where.stepKey !== undefined) rows = rows.filter((r) => r.stepKey === where.stepKey);
        if (where.activeForBot !== undefined) rows = rows.filter((r) => r.activeForBot === where.activeForBot);
        if (orderBy?.version === 'desc') rows.sort((a, b) => b.version - a.version);
        else rows.sort((a, b) => a.version - b.version);
        const first = rows[0];
        if (!first) return null;
        return { payload: first.payload, status: first.status, version: first.version };
      },
    },
  };
}

async function readTier(db: ReturnType<typeof makeFakePrisma>, clientId: string): Promise<Tier> {
  const client = await db.chatbotClient.findUnique({ where: { id: clientId }, select: { tier: true } });
  if (!client) throw new Error('client_not_found');
  return normaliseTier(client.tier);
}

async function readSavedStep(
  db: ReturnType<typeof makeFakePrisma>,
  clientId: string,
  stepNumber: WizardStepNumber,
) {
  const stepKey = String(stepNumber);
  const row = await db.chatbotConfigStep.findFirst({
    where: { clientId, stepKey },
    orderBy: { version: 'desc' },
  });
  if (!row) return null;
  return { payload: row.payload as Record<string, unknown> | null, status: row.status, version: row.version };
}

// -----------------------------------------------------------------------------
// Seed the in-memory store.
// -----------------------------------------------------------------------------

const STARTER_ID = randomUUID();
const PRO_ID = randomUUID();
const STARTER_SAVED_STEP3 = {
  id: randomUUID(),
  clientId: STARTER_ID,
  stepKey: '3',
  version: 1,
  status: 'submitted',
  payload: { servicios: ['corte'], precio_tipo: 'fijo' } as Record<string, unknown>,
  activeForBot: false,
};
const PRO_SAVED_STEP3 = {
  id: randomUUID(),
  clientId: PRO_ID,
  stepKey: '3',
  version: 2,
  status: 'submitted',
  payload: { servicios: ['tinte', 'corte'], precio_tipo: 'rango' } as Record<string, unknown>,
  activeForBot: false,
};

fakeClients.set(STARTER_ID, { id: STARTER_ID, tier: 'starter' });
fakeClients.set(PRO_ID, { id: PRO_ID, tier: 'pro' });
fakeSteps.push(STARTER_SAVED_STEP3, PRO_SAVED_STEP3);

const prisma = makeFakePrisma();

// -----------------------------------------------------------------------------
// Smoke checks (wrapped in async main to keep `tsx` happy in CJS mode).
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('--- KAIA-1166 BE-4 tier-aware wizard service smoke ---\n');

  // 1. Cliente list — Starter sees 9 entries (1, 2, 4, 5, 6, 8, 9, 10, 11).
  {
    const tier = await readTier(prisma, STARTER_ID);
    const out = { clientId: STARTER_ID, tier, steps: listStepsForClient(tier) };
    assertEq('starter list length', out.steps.length, 9);
    assertEq('starter list numbers', out.steps.map((s) => s.number), [1, 2, 4, 5, 6, 8, 9, 10, 11]);
    assertEq('starter list tier', out.tier, 'starter');
    assertEq('starter list clientId', out.clientId, STARTER_ID);
    for (const s of out.steps) {
      assertTrue(`starter step ${s.number} visible=true`, s.visible === true);
      assertTrue(`starter step ${s.number} autoConfigured=false`, s.autoConfigured === false);
    }
  }

  // 2. Cliente list — Pro sees 11 entries (1..11).
  {
    const tier = await readTier(prisma, PRO_ID);
    const out = { clientId: PRO_ID, tier, steps: listStepsForClient(tier) };
    assertEq('pro list length', out.steps.length, 11);
    assertEq('pro list numbers', out.steps.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assertEq('pro list tier', out.tier, 'pro');
  }

  // 3. Cliente single — Starter on Step 3 returns hidden + autoConfigured defaults (even though saved exists).
  {
    const tier = await readTier(prisma, STARTER_ID);
    const saved = await readSavedStep(prisma, STARTER_ID, 3 as WizardStepNumber);
    const out = resolveClientStep(3 as WizardStepNumber, tier, saved);
    assertEq('starter step 3 kind', out.kind, 'hidden');
    if (out.kind === 'hidden') {
      assertEq('starter step 3 effectivePayload', out.data.effectivePayload, { servicios: [], precio_tipo: 'consultar' });
      assertEq('starter step 3 autoConfigured', out.data.autoConfigured, true);
      assertEq('starter step 3 visible', out.data.visible, false);
      assertEq('starter step 3 savedPayload (preserved for audit)', out.data.savedPayload, { servicios: ['corte'], precio_tipo: 'fijo' });
    }
  }

  // 4. Cliente single — Starter on Step 7 returns hidden defaults.
  {
    const tier = await readTier(prisma, STARTER_ID);
    const saved = await readSavedStep(prisma, STARTER_ID, 7 as WizardStepNumber);
    const out = resolveClientStep(7 as WizardStepNumber, tier, saved);
    assertEq('starter step 7 kind', out.kind, 'hidden');
    if (out.kind === 'hidden') {
      assertEq('starter step 7 effectivePayload', out.data.effectivePayload, { reglas: [], fallback_sin_respuesta: 'derivar' });
    }
  }

  // 5. Cliente single — Starter on Step 12 returns hidden (v1 reservation).
  {
    const tier = await readTier(prisma, STARTER_ID);
    const saved = await readSavedStep(prisma, STARTER_ID, 12 as WizardStepNumber);
    const out = resolveClientStep(12 as WizardStepNumber, tier, saved);
    assertEq('starter step 12 kind', out.kind, 'hidden');
    if (out.kind === 'hidden') {
      assertEq('starter step 12 autoConfigured', out.data.autoConfigured, true);
    }
  }

  // 6. Cliente single — Pro on Step 3 returns visible + saved payload.
  {
    const tier = await readTier(prisma, PRO_ID);
    const saved = await readSavedStep(prisma, PRO_ID, 3 as WizardStepNumber);
    const out = resolveClientStep(3 as WizardStepNumber, tier, saved);
    assertEq('pro step 3 kind', out.kind, 'found');
    if (out.kind === 'found') {
      assertEq('pro step 3 effectivePayload', out.data.effectivePayload, { servicios: ['tinte', 'corte'], precio_tipo: 'rango' });
      assertEq('pro step 3 autoConfigured', out.data.autoConfigured, false);
      assertEq('pro step 3 visible', out.data.visible, true);
    }
  }

  // 7. Cliente single — Pro on Step 7 (no saved payload) returns visible + default + autoConfigured=true.
  {
    const tier = await readTier(prisma, PRO_ID);
    const saved = await readSavedStep(prisma, PRO_ID, 7 as WizardStepNumber);
    const out = resolveClientStep(7 as WizardStepNumber, tier, saved);
    assertEq('pro step 7 kind', out.kind, 'found');
    if (out.kind === 'found') {
      assertEq('pro step 7 effectivePayload', out.data.effectivePayload, { reglas: [], fallback_sin_respuesta: 'derivar' });
      assertEq('pro step 7 autoConfigured (defaults when no saved data)', out.data.autoConfigured, true);
    }
  }

  // 8. Cliente single — out-of-range returns not_found.
  {
    const a = resolveClientStep(0 as WizardStepNumber, 'pro', null);
    const b = resolveClientStep(13 as WizardStepNumber, 'pro', null);
    const c = resolveClientStep(1.5 as WizardStepNumber, 'pro', null);
    assertEq('cliente out-of-range 0 → not_found', a.kind, 'not_found');
    assertEq('cliente out-of-range 13 → not_found', b.kind, 'not_found');
    assertEq('cliente out-of-range 1.5 → not_found', c.kind, 'not_found');
  }

  // 9. Operator list — always 12 entries regardless of tier.
  {
    const tierStarter = await readTier(prisma, STARTER_ID);
    const tierPro = await readTier(prisma, PRO_ID);
    const outStarter = { clientId: STARTER_ID, tier: tierStarter, steps: listStepsForOperator(tierStarter) };
    const outPro = { clientId: PRO_ID, tier: tierPro, steps: listStepsForOperator(tierPro) };
    assertEq('operator starter list length', outStarter.steps.length, 12);
    assertEq('operator pro list length', outPro.steps.length, 12);
    assertEq('operator starter tier surfaced', outStarter.tier, 'starter');
    assertEq('operator pro tier surfaced', outPro.tier, 'pro');
    for (const s of outStarter.steps) {
      assertTrue(`operator starter step ${s.number} visible=true`, s.visible === true);
    }
    assertTrue('operator starter list contains Step 12', outStarter.steps.some((s) => s.number === 12));
  }

  // 10. Operator single — Starter on Step 3 with saved payload.
  {
    const tier = await readTier(prisma, STARTER_ID);
    const saved = await readSavedStep(prisma, STARTER_ID, 3 as WizardStepNumber);
    const out = resolveOperatorStep(3 as WizardStepNumber, tier, saved);
    assertEq('operator starter step 3 kind', out.kind, 'found');
    if (out.kind === 'found') {
      assertEq('operator starter step 3 savedPayload', out.data!.savedPayload, { servicios: ['corte'], precio_tipo: 'fijo' });
      assertEq('operator starter step 3 defaultPayload', out.data!.defaultPayload, { servicios: [], precio_tipo: 'consultar' });
      assertEq('operator starter step 3 autoConfigured (no, saved exists)', out.data!.autoConfigured, false);
      assertEq('operator starter step 3 status', out.data!.status, 'submitted');
      assertEq('operator starter step 3 version', out.data!.version, 1);
    }
  }

  // 11. Operator single — Starter on Step 1 (visible) with no saved payload, autoConfigured=false (because visible).
  {
    const tier = await readTier(prisma, STARTER_ID);
    const saved = await readSavedStep(prisma, STARTER_ID, 1 as WizardStepNumber);
    const out = resolveOperatorStep(1 as WizardStepNumber, tier, saved);
    assertEq('operator starter step 1 kind', out.kind, 'found');
    if (out.kind === 'found') {
      assertEq('operator starter step 1 autoConfigured (visible to starter)', out.data!.autoConfigured, false);
      assertEq('operator starter step 1 savedPayload', out.data!.savedPayload, null);
      assertEq('operator starter step 1 status', out.data!.status, null);
    }
  }

  // 12. Operator single — Pro on Step 3 with no saved payload, autoConfigured=false (because visible to Pro).
  {
    const FRESH_PRO = randomUUID();
    fakeClients.set(FRESH_PRO, { id: FRESH_PRO, tier: 'pro' });
    const tier = await readTier(prisma, FRESH_PRO);
    const saved = await readSavedStep(prisma, FRESH_PRO, 3 as WizardStepNumber);
    const out = resolveOperatorStep(3 as WizardStepNumber, tier, saved);
    assertEq('operator fresh-pro step 3 kind', out.kind, 'found');
    if (out.kind === 'found') {
      assertEq('operator fresh-pro step 3 autoConfigured (visible, no saved)', out.data!.autoConfigured, false);
      assertEq('operator fresh-pro step 3 savedPayload', out.data!.savedPayload, null);
    }
  }

  // 13. Operator single — any tier on Step 12 with no saved payload, autoConfigured=true (hidden in v1).
  {
    const FRESH_STARTER = randomUUID();
    fakeClients.set(FRESH_STARTER, { id: FRESH_STARTER, tier: 'starter' });
    const tier = await readTier(prisma, FRESH_STARTER);
    const saved = await readSavedStep(prisma, FRESH_STARTER, 12 as WizardStepNumber);
    const out = resolveOperatorStep(12 as WizardStepNumber, tier, saved);
    assertEq('operator fresh-starter step 12 kind', out.kind, 'found');
    if (out.kind === 'found') {
      assertEq('operator fresh-starter step 12 autoConfigured (hidden in v1)', out.data!.autoConfigured, true);
    }
  }

  // 14. Operator single — out-of-range returns not_found.
  {
    const a = resolveOperatorStep(0 as WizardStepNumber, 'pro', null);
    const b = resolveOperatorStep(99 as WizardStepNumber, 'pro', null);
    assertEq('operator out-of-range 0 → not_found', a.kind, 'not_found');
    assertEq('operator out-of-range 99 → not_found', b.kind, 'not_found');
  }

  // 15. Unknown cliente → readTier throws.
  {
    const UNKNOWN = randomUUID();
    let threw = false;
    try {
      await readTier(prisma, UNKNOWN);
    } catch (e) {
      threw = (e as Error).message === 'client_not_found';
    }
    assertTrue('unknown cliente throws client_not_found', threw);
  }

  // 16. Pure visibility matrix sanity check (the catalog).
  {
    assertEq('catalog step 3 default', getCatalogEntryByNumber(3)?.defaultPayload, { servicios: [], precio_tipo: 'consultar' });
    assertEq('catalog step 7 default', getCatalogEntryByNumber(7)?.defaultPayload, { reglas: [], fallback_sin_respuesta: 'derivar' });
    assertEq('catalog step 12 visibleFor (empty in v1)', getCatalogEntryByNumber(12)?.visibleFor.size, 0);
    assertTrue('step 12 is operator-visible', isOperatorVisible(12));
    assertTrue('step 12 is NOT cliente-visible (starter)', !isVisibleForTier(12, 'starter'));
    assertTrue('step 12 is NOT cliente-visible (pro)', !isVisibleForTier(12, 'pro'));
    assertTrue('step 12 is NOT cliente-visible (premium)', !isVisibleForTier(12, 'premium'));
    assertTrue('step 3 is NOT cliente-visible (starter)', !isVisibleForTier(3, 'starter'));
    assertTrue('step 3 IS cliente-visible (pro)', isVisibleForTier(3, 'pro'));
    assertTrue('step 3 IS cliente-visible (premium)', isVisibleForTier(3, 'premium'));
  }

  // 17. Catalog completeness — every number 1..12 has a key + block + non-null default.
  {
    for (const n of WIZARD_STEP_NUMBERS) {
      const entry = getCatalogEntryByNumber(n);
      assertTrue(`catalog step ${n} present`, entry !== null);
      assertTrue(`catalog step ${n} key matches number`, entry?.key === String(n));
      assertTrue(`catalog step ${n} block in {setup,services,review}`, entry !== null && ['setup', 'services', 'review'].includes(entry.block));
      assertTrue(`catalog step ${n} defaultPayload is a non-null object`, entry !== null && typeof entry.defaultPayload === 'object' && entry.defaultPayload !== null);
    }
  }

  console.log(`\n--- ${assertionCount} assertions, ${failureCount} failures ---`);
  if (failureCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
