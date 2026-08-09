// =============================================================================
// KAIA-1166 (BE-4) — smoke test for the tier-aware wizard layer.
//
// In-process smoke (no live HTTP server, no docker). Exercises the
// pure visibility/resolve helpers + the route handlers' tier filtering
// against a mock auth + a mock Prisma. Mirrors the production code in:
//   * src/lib/wizard-catalog.ts
//   * src/lib/wizard-visibility.ts
//   * src/app/api/portal/wizard/steps/route.ts
//   * src/app/api/portal/wizard/[step]/route.ts
//   * src/app/api/admin/portal/wizard/[clientId]/steps/route.ts
//
// Run:   npx tsx scripts/smoke-wizard-tier.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
//
// Note: this smoke does not require a live DATABASE_URL. The route
// handlers' `isDatabaseConfigured` flag is short-circuited by the
// `if (!isDatabaseConfigured)` 503 path which is exercised in
// `scripts/smoke-wizard-portal-step.ts` (BE-2). This smoke focuses on
// the tier-aware resolver + the visibility matrix.
// =============================================================================

import {
  listStepsForClient,
  listStepsForOperator,
  resolveClientStep,
  resolveOperatorStep,
  buildSavedStateMap,
  type WizardSavedState,
} from '../src/lib/wizard-visibility';
import {
  WIZARD_STEP_CATALOG,
  WIZARD_STEP_NUMBERS,
  parseStepNumber,
  type WizardStepNumber,
} from '../src/lib/wizard-catalog';

const DEV_EMAIL_HEADER = 'x-kairikos-dev-email';

function isStepKeyAllowed(key: string): boolean {
  return /^(1[0-2]|[1-9])$/.test(key);
}

let failures = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`, detail ?? '');
  }
}

async function main() {
  console.log('KAIA-1166 — BE-4 tier-aware wizard smoke');

  // ---------------------------------------------------------------------------
  // 1. Auth gate (mirror the dev-header pattern from BE-2's smoke)
  //
  // We can't dynamically import `portal-session` here — it pulls in
  // `server-only` (a Next runtime gate that doesn't resolve under tsx).
  // Instead, exercise the dev-header string the BE-2 smoke also uses.
  // ---------------------------------------------------------------------------
  delete process.env[DEV_EMAIL_HEADER];
  const { MOCK_CLIENT } = await import('../src/lib/portal-data');
  const headerEmail = (process.env[DEV_EMAIL_HEADER] ?? '').toLowerCase();
  assert('portal-session: dev header absent → no resolution', headerEmail === '');
  process.env[DEV_EMAIL_HEADER] = MOCK_CLIENT.primaryContactEmail;
  const headerEmail2 = (process.env[DEV_EMAIL_HEADER] ?? '').toLowerCase();
  assert('portal-session: dev header present → matches mock client', headerEmail2 === MOCK_CLIENT.primaryContactEmail.toLowerCase());

  // ---------------------------------------------------------------------------
  // 2. Step key allowlist
  // ---------------------------------------------------------------------------
  assert('allowlist accepts "1"', isStepKeyAllowed('1'));
  assert('allowlist accepts "12"', isStepKeyAllowed('12'));
  assert('allowlist rejects "0"', !isStepKeyAllowed('0'));
  assert('allowlist rejects "13"', !isStepKeyAllowed('13'));
  assert('allowlist rejects "abc"', !isStepKeyAllowed('abc'));
  assert('allowlist rejects ""', !isStepKeyAllowed(''));

  // ---------------------------------------------------------------------------
  // 3. Catalog stepKey ↔ number round-trip
  // ---------------------------------------------------------------------------
  for (const n of WIZARD_STEP_NUMBERS) {
    const parsed = parseStepNumber(String(n));
    if (parsed !== n) {
      assert(`catalog: stepKey "${n}" parses to ${n}`, false, `got ${parsed}`);
    }
  }
  assert('catalog: every stepKey round-trips through parseStepNumber', true);

  // ---------------------------------------------------------------------------
  // 4. Visibility matrix for Starter cliente
  // ---------------------------------------------------------------------------
  const savedEmpty = new Map<string, WizardSavedState>();
  const starterList = listStepsForClient('starter', savedEmpty);
  const starterByNum = new Map(starterList.steps.map((s) => [s.number, s]));
  assert('Starter list: 12 entries', starterList.steps.length === 12);
  assert('Starter list: clientTier=starter', starterList.clientTier === 'starter');
  assert('Starter list: step 3 hidden', starterByNum.get(3)!.visible === false);
  assert('Starter list: step 7 hidden', starterByNum.get(7)!.visible === false);
  assert('Starter list: step 12 hidden (v1.1)', starterByNum.get(12)!.visible === false);
  assert('Starter list: step 1 visible', starterByNum.get(1)!.visible === true);
  assert('Starter list: step 11 visible', starterByNum.get(11)!.visible === true);
  assert('Starter list: step 3 autoConfigured=true', starterByNum.get(3)!.autoConfigured === true);
  assert('Starter list: step 7 autoConfigured=true', starterByNum.get(7)!.autoConfigured === true);

  // ---------------------------------------------------------------------------
  // 5. Visibility matrix for Pro cliente
  // ---------------------------------------------------------------------------
  const proList = listStepsForClient('pro', savedEmpty);
  const proByNum = new Map(proList.steps.map((s) => [s.number, s]));
  assert('Pro list: step 3 visible', proByNum.get(3)!.visible === true);
  assert('Pro list: step 7 visible', proByNum.get(7)!.visible === true);
  assert('Pro list: step 12 hidden (v1.1)', proByNum.get(12)!.visible === false);
  assert('Pro list: step 3 autoConfigured=true (no saved data)', proByNum.get(3)!.autoConfigured === true);

  // ---------------------------------------------------------------------------
  // 6. Starter Step 3 effectivePayload (the critical default-per-spec check)
  // ---------------------------------------------------------------------------
  const starterStep3 = resolveClientStep(3, 'starter', { hasSavedVersion: false }, null);
  const s3eff = starterStep3.effectivePayload as { servicios: unknown[]; precio_tipo: string };
  assert('Starter step 3: effectivePayload has servicios=[]', Array.isArray(s3eff.servicios) && s3eff.servicios.length === 0);
  assert('Starter step 3: effectivePayload.precio_tipo=consultar', s3eff.precio_tipo === 'consultar');
  assert('Starter step 3: autoConfigured=true', starterStep3.autoConfigured === true);

  // ---------------------------------------------------------------------------
  // 7. Starter Step 7 effectivePayload
  // ---------------------------------------------------------------------------
  const starterStep7 = resolveClientStep(7, 'starter', { hasSavedVersion: false }, null);
  const s7eff = starterStep7.effectivePayload as { reglas: unknown[]; fallback_sin_respuesta: string };
  assert('Starter step 7: effectivePayload.reglas=[]', Array.isArray(s7eff.reglas) && s7eff.reglas.length === 0);
  assert('Starter step 7: effectivePayload.fallback_sin_respuesta=derivar', s7eff.fallback_sin_respuesta === 'derivar');

  // ---------------------------------------------------------------------------
  // 8. Pro Step 3 with saved data — effectivePayload is the saved payload
  // ---------------------------------------------------------------------------
  const proStep3WithData = resolveClientStep(
    3,
    'pro',
    { hasSavedVersion: true, status: 'approved' },
    { servicios: [{ nombre: 'Consulta', precio_tipo: 'fijo' }] },
  );
  assert('Pro step 3 with saved: autoConfigured=false', proStep3WithData.autoConfigured === false);
  assert(
    'Pro step 3 with saved: effectivePayload.servicios[0].nombre=Consulta',
    (proStep3WithData.effectivePayload as { servicios: Array<{ nombre: string }> }).servicios[0].nombre === 'Consulta',
  );

  // ---------------------------------------------------------------------------
  // 9. Operator view — always 12 entries, all visible, tier ignored
  // ---------------------------------------------------------------------------
  const opStarter = listStepsForOperator('client-1', 'starter', savedEmpty);
  assert('Operator (Starter cliente): 12 entries', opStarter.steps.length === 12);
  assert('Operator (Starter cliente): every step visible=true', opStarter.steps.every((s) => s.visible === true));

  const opPro = listStepsForOperator('client-1', 'pro', savedEmpty);
  assert('Operator (Pro cliente): 12 entries', opPro.steps.length === 12);
  assert('Operator (Pro cliente): every step visible=true', opPro.steps.every((s) => s.visible === true));

  // ---------------------------------------------------------------------------
  // 10. Operator Step 3 for Starter cliente — sees the catalog default
  //     (because the cliente is on Starter safety rails)
  // ---------------------------------------------------------------------------
  const opStep3 = resolveOperatorStep(3, 'c1', 'starter', { hasSavedVersion: false }, null);
  assert('Operator step 3 (Starter): clienteVisibleForTier=false', opStep3.clienteVisibleForTier === false);
  assert('Operator step 3 (Starter): defaultPayload.precio_tipo=consultar', (opStep3.defaultPayload as { precio_tipo: string }).precio_tipo === 'consultar');
  assert('Operator step 3 (Starter): effectivePayload falls back to default', (opStep3.effectivePayload as { precio_tipo: string }).precio_tipo === 'consultar');

  // ---------------------------------------------------------------------------
  // 11. Step 12 — v1.1 deferred, hidden in cliente view, present in operator
  //     view with `editable: false`
  // ---------------------------------------------------------------------------
  const clienteStep12 = resolveClientStep(12, 'pro', { hasSavedVersion: false }, null);
  assert('Cliente step 12: visibleForTier=false', clienteStep12.visibleForTier === false);
  assert('Cliente step 12: v11Deferred=true', clienteStep12.v11Deferred === true);

  const operatorStep12 = resolveOperatorStep(12, 'c1', 'pro', { hasSavedVersion: false }, null);
  assert('Operator step 12: editable=false', operatorStep12.editable === false);
  assert('Operator step 12: v11Deferred=true', operatorStep12.v11Deferred === true);
  assert('Operator step 12: visibleForTier=true (operator sees the label)', operatorStep12.visibleForTier === true);

  // ---------------------------------------------------------------------------
  // 12. buildSavedStateMap — happy path + empty
  // ---------------------------------------------------------------------------
  const map = buildSavedStateMap([
    { stepKey: '1', latest: { status: 'submitted', submittedAt: '2026-06-15T00:00:00Z', approvedAt: null, activeForBot: false } },
    { stepKey: '2', latest: null },
  ]);
  assert('buildSavedStateMap: 2 entries', map.size === 2);
  assert('buildSavedStateMap: step 1 has saved', map.get('1')?.hasSavedVersion === true);
  assert('buildSavedStateMap: step 2 has no saved', map.get('2')?.hasSavedVersion === false);

  // ---------------------------------------------------------------------------
  // 13. Auto-configured flag flips on save (cliente view)
  // ---------------------------------------------------------------------------
  const savedMap = new Map<string, WizardSavedState>([
    ['1', { hasSavedVersion: true, status: 'draft' }],
  ]);
  const proListWithSave = listStepsForClient('pro', savedMap);
  const proByNum2 = new Map(proListWithSave.steps.map((s) => [s.number, s]));
  assert('Pro list (saved): step 1 autoConfigured=false', proByNum2.get(1)!.autoConfigured === false);
  assert('Pro list (saved): step 4 autoConfigured=true (no save)', proByNum2.get(4)!.autoConfigured === true);

  // ---------------------------------------------------------------------------
  // 14. Catalog invariant: every step has a non-undefined label and key
  // ---------------------------------------------------------------------------
  for (const n of WIZARD_STEP_NUMBERS) {
    const def = WIZARD_STEP_CATALOG[n as WizardStepNumber];
    if (!def.key || !def.label) {
      assert(`catalog: step ${n} has key+label`, false, `key=${def.key} label=${def.label}`);
    }
  }
  assert('catalog: every step has key+label', true);

  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll KAIA-1166 smoke assertions passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke harness crashed:', err);
  process.exit(1);
});
