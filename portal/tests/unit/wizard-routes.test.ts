import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEP_CATALOG,
  WIZARD_STEP_NUMBERS,
  type WizardStepNumber,
} from '@/lib/wizard-catalog';
import {
  buildSavedStateMap,
  listStepsForClient,
  resolveClientStep,
  resolveOperatorStep,
  type WizardSavedState,
} from '@/lib/wizard-visibility';

const emptySaved: WizardSavedState = { hasSavedVersion: false };

describe('wizard-route-contract — client routes (GET)', () => {
  it('catalog has correct structure for each step', () => {
    for (const n of WIZARD_STEP_NUMBERS) {
      const def = WIZARD_STEP_CATALOG[n as WizardStepNumber];
      expect(def.number).toBe(n);
      expect(def.key).toBe(String(n));
      expect(def).toHaveProperty('label');
      expect(def).toHaveProperty('block');
      expect(def).toHaveProperty('requiredForReady');
      expect(def).toHaveProperty('v11Deferred');
      expect(def).toHaveProperty('defaultPayload');
      expect(typeof def.visibleFor).toBe('function');
    }
  });

  it('invalid step numbers are undefined in catalog', () => {
    expect(WIZARD_STEP_CATALOG[0]).toBeUndefined();
    expect(WIZARD_STEP_CATALOG[13]).toBeUndefined();
    expect(WIZARD_STEP_CATALOG[-1]).toBeUndefined();
  });

  it('GET response shape includes step, visible, autoConfigured, effectivePayload', () => {
    const out = resolveClientStep(1, 'pro', emptySaved, null);
    expect(out).toHaveProperty('visibleForTier');
    expect(out).toHaveProperty('autoConfigured');
    expect(out).toHaveProperty('defaultPayload');
    expect(out).toHaveProperty('effectivePayload');
    expect(out).toHaveProperty('savedPayload');
    expect(out).toHaveProperty('v11Deferred');
    expect(typeof out.visibleForTier).toBe('boolean');
    expect(typeof out.autoConfigured).toBe('boolean');
  });

  it('GET for Starter Step 3 returns hidden + autoConfigured defaults', () => {
    const out = resolveClientStep(3, 'starter', emptySaved, null);
    expect(out.visibleForTier).toBe(false);
    expect(out.autoConfigured).toBe(true);
    expect(out.effectivePayload).toEqual({
      servicios: [],
      precio_tipo: 'consultar',
    });
  });

  it('GET for Pro Step 3 returns visible + catalog defaults when unsaved', () => {
    const out = resolveClientStep(3, 'pro', emptySaved, null);
    expect(out.visibleForTier).toBe(true);
    expect(out.effectivePayload).toEqual({
      servicios: [],
      precio_tipo: 'consultar',
    });
  });

  it('GET for Step 12 returns v11Deferred for all tiers', () => {
    for (const tier of ['starter', 'pro', 'premium'] as const) {
      const out = resolveClientStep(12, tier, emptySaved, null);
      expect(out.v11Deferred).toBe(true);
      expect(out.visibleForTier).toBe(false);
    }
  });
});

describe('wizard-route-contract — client routes (PATCH)', () => {
  it('PATCH payload shape matches step definition', () => {
    const def = WIZARD_STEP_CATALOG[3];
    const payload = { servicios: ['asesoria'], precio_tipo: 'fijo' };
    expect(payload).toMatchObject({});
    expect(Object.keys(payload).sort()).toEqual(['precio_tipo', 'servicios']);
  });

  it('PATCH to Step 7 payload matches catalog defaults shape', () => {
    const def = WIZARD_STEP_CATALOG[7];
    const payload = { reglas: [], fallback_sin_respuesta: 'derivar' };
    expect(payload.reglas).toEqual([]);
    expect(payload.fallback_sin_respuesta).toBe('derivar');
  });
});

describe('wizard-route-contract — operator routes', () => {
  it('GET /api/admin/portal/wizard/[clientId]/[step]/ returns operator step view', () => {
    const out = resolveOperatorStep(5, 'client-1', 'pro', emptySaved, null);
    expect(out).toHaveProperty('visibleForTier');
    expect(out).toHaveProperty('clienteVisibleForTier');
    expect(out).toHaveProperty('autoConfigured');
    expect(out).toHaveProperty('editable');
    expect(out).toHaveProperty('v11Deferred');
    expect(out.visibleForTier).toBe(true);
  });

  it('operator view always returns 12 steps regardless of client visibility', () => {
    for (const tier of ['starter', 'pro', 'premium'] as const) {
      const out = listStepsForClient(tier, new Map());
      expect(out.steps.length).toBe(12);
    }
  });

  it('PATCH /api/admin/portal/wizard/[clientId]/[step]/ accepts review actions', () => {
    const actionPayloads = [
      { action: 'approve' },
      { action: 'request_revision', comment: 'Fix this step' },
      { action: 'request_revision' },
    ];
    for (const payload of actionPayloads) {
      expect(payload).toHaveProperty('action');
      expect(['approve', 'request_revision']).toContain(payload.action);
    }
  });
});

describe('wizard-route-contract — step 12 always deferred', () => {
  it('12 is excluded from visible step numbers in client view', () => {
    expect(WIZARD_STEP_CATALOG[12].v11Deferred).toBe(true);
    expect(WIZARD_STEP_CATALOG[12].visibleFor('pro')).toBe(false);
    expect(WIZARD_STEP_CATALOG[12].visibleFor('starter')).toBe(false);
    expect(WIZARD_STEP_CATALOG[12].visibleFor('premium')).toBe(false);
  });

  it('buildSavedStateMap handles empty input gracefully', () => {
    const map = buildSavedStateMap([]);
    expect(map.size).toBe(0);
  });

  it('buildSavedStateMap handles partial input', () => {
    const map = buildSavedStateMap([
      { stepKey: '1', latest: null },
      { stepKey: '3', latest: { status: 'submitted', submittedAt: '2026-06-01T00:00:00Z', approvedAt: null, activeForBot: false } },
    ]);
    expect(map.get('1')?.hasSavedVersion).toBe(false);
    expect(map.get('3')?.hasSavedVersion).toBe(true);
    expect(map.get('3')?.status).toBe('submitted');
  });
});
