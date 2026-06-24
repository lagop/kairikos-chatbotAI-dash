// =============================================================================
// KAIA-1166 (BE-4) — Unit tests for the tier-aware wizard layer.
//
// Pure-function tests for `wizard-catalog.ts` and `wizard-visibility.ts`.
// No DB, no network. The route-layer integration is covered by the
// BE-2/BE-3 smoke tests + the new BE-4 smoke test.
//
// Coverage:
//   * Catalog length, key names, out-of-range.
//   * Visibility matrix per tier (Starter / Pro / Premium) for Steps 3, 7, 12.
//   * Step 12 always-hidden invariant (cliente view).
//   * Default payload values for Step 3 and Step 7.
//   * Cliente view: autoConfigured flips correctly when saved data is present.
//   * Operator view: always 12 steps, all visible, ignores tier.
//   * Build saved-state map.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEP_CATALOG,
  WIZARD_STEP_KEYS,
  WIZARD_STEP_NUMBERS,
  WIZARD_VISIBLE_STEP_NUMBERS,
  parseStepNumber,
  getStepDefinition,
  normalizeTier,
  WizardCatalogError,
  type WizardStepNumber,
  type WizardTier,
} from '@/lib/wizard-catalog';
import {
  listStepsForClient,
  listStepsForOperator,
  resolveClientStep,
  resolveOperatorStep,
  buildSavedStateMap,
  type WizardSavedState,
} from '@/lib/wizard-visibility';

const emptySaved: WizardSavedState = { hasSavedVersion: false };

describe('wizard-catalog', () => {
  it('has exactly 12 steps numbered 1..12', () => {
    expect(WIZARD_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('exposes the same keys as the stepKey allowlist (matches BE-2 wizard-client.ts)', () => {
    for (const n of WIZARD_STEP_NUMBERS) {
      expect(WIZARD_STEP_KEYS.has(String(n))).toBe(true);
    }
  });

  it('frozen — assigning a new key is a TypeError in strict mode', () => {
    expect(() => {
      // Cast to any to bypass the type guard; the runtime is what we test.
      (WIZARD_STEP_CATALOG as unknown as Record<string, unknown>)['99'] = { invalid: true };
    }).toThrow(TypeError);
  });

  it('parseStepNumber accepts "1".."12" and rejects everything else', () => {
    expect(parseStepNumber('1')).toBe(1);
    expect(parseStepNumber('12')).toBe(12);
    expect(() => parseStepNumber('0')).toThrow(WizardCatalogError);
    expect(() => parseStepNumber('13')).toThrow(WizardCatalogError);
    expect(() => parseStepNumber('abc')).toThrow(WizardCatalogError);
    expect(() => parseStepNumber('')).toThrow(WizardCatalogError);
  });

  it('parseStepNumber error code is invalid_step_number', () => {
    try {
      parseStepNumber('99');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WizardCatalogError);
      expect((e as WizardCatalogError).error.code).toBe('invalid_step_number');
      expect((e as WizardCatalogError).error.value).toBe('99');
    }
  });

  it('normalizeTier maps known values and treats unknowns as null', () => {
    expect(normalizeTier('starter')).toBe('starter');
    expect(normalizeTier('pro')).toBe('pro');
    expect(normalizeTier('premium')).toBe('premium');
    expect(normalizeTier('STARTER')).toBeNull();
    expect(normalizeTier('enterprise')).toBeNull();
    expect(normalizeTier(null)).toBeNull();
    expect(normalizeTier(undefined)).toBeNull();
  });

  it('Step 3 default payload matches spec', () => {
    const def = getStepDefinition(3);
    expect(def.defaultPayload).toEqual({
      servicios: [],
      precio_tipo: 'consultar',
    });
  });

  it('Step 7 default payload matches spec', () => {
    const def = getStepDefinition(7);
    expect(def.defaultPayload).toEqual({
      reglas: [],
      fallback_sin_respuesta: 'derivar',
    });
  });

  it('Step 12 is marked v11Deferred and never visible in cliente view', () => {
    const def = getStepDefinition(12);
    expect(def.v11Deferred).toBe(true);
    expect(def.visibleFor('starter')).toBe(false);
    expect(def.visibleFor('pro')).toBe(false);
    expect(def.visibleFor('premium')).toBe(false);
    expect(def.visibleFor(null)).toBe(false);
  });

  it('Step 3 is hidden for Starter and visible for Pro/Premium', () => {
    const def = getStepDefinition(3);
    expect(def.visibleFor('starter')).toBe(false);
    expect(def.visibleFor('pro')).toBe(true);
    expect(def.visibleFor('premium')).toBe(true);
    expect(def.visibleFor(null)).toBe(false); // null tier defaults to starter
  });

  it('Step 7 is hidden for Starter and visible for Pro/Premium', () => {
    const def = getStepDefinition(7);
    expect(def.visibleFor('starter')).toBe(false);
    expect(def.visibleFor('pro')).toBe(true);
    expect(def.visibleFor('premium')).toBe(true);
    expect(def.visibleFor(null)).toBe(false);
  });

  it('Steps 1, 2, 4, 5, 6, 8, 9, 10, 11 are visible for every tier', () => {
    for (const n of [1, 2, 4, 5, 6, 8, 9, 10, 11]) {
      const def = getStepDefinition(n as WizardStepNumber);
      expect(def.visibleFor('starter'), `step ${n} starter`).toBe(true);
      expect(def.visibleFor('pro'), `step ${n} pro`).toBe(true);
      expect(def.visibleFor('premium'), `step ${n} premium`).toBe(true);
    }
  });

  it('requiredForReady covers the 10 spec-mandatory steps', () => {
    const required = WIZARD_STEP_NUMBERS.filter((n) => WIZARD_STEP_CATALOG[n].requiredForReady);
    expect(required).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
  });

  it('blocks are identidad / comportamiento / activacion', () => {
    expect(getStepDefinition(1).block).toBe('identidad');
    expect(getStepDefinition(4).block).toBe('identidad');
    expect(getStepDefinition(5).block).toBe('comportamiento');
    expect(getStepDefinition(9).block).toBe('comportamiento');
    expect(getStepDefinition(10).block).toBe('activacion');
    expect(getStepDefinition(11).block).toBe('activacion');
  });

  it('V11 deferred step is excluded from WIZARD_VISIBLE_STEP_NUMBERS', () => {
    expect(WIZARD_VISIBLE_STEP_NUMBERS).not.toContain(12);
    expect(WIZARD_VISIBLE_STEP_NUMBERS).toContain(11);
    expect(WIZARD_VISIBLE_STEP_NUMBERS.length).toBe(11);
  });
});

describe('listStepsForClient — cliente view', () => {
  it('Starter sees 9 visible steps, with 3 and 7 hidden + autoConfigured=true', () => {
    const out = listStepsForClient('starter', new Map());
    expect(out.clientTier).toBe('starter');
    expect(out.steps.length).toBe(12);

    const byNum = new Map(out.steps.map((s) => [s.number, s]));

    expect(byNum.get(3)!.visible).toBe(false);
    expect(byNum.get(3)!.autoConfigured).toBe(true);

    expect(byNum.get(7)!.visible).toBe(false);
    expect(byNum.get(7)!.autoConfigured).toBe(true);

    expect(byNum.get(12)!.visible).toBe(false);
    expect(byNum.get(12)!.v11Deferred).toBe(true);

    // 1, 2, 4, 5, 6, 8, 9, 10, 11 visible; autoConfigured = true when
    // the cliente hasn't saved anything (cold start).
    for (const n of [1, 2, 4, 5, 6, 8, 9, 10, 11]) {
      expect(byNum.get(n as WizardStepNumber)!.visible, `step ${n}`).toBe(true);
      expect(byNum.get(n as WizardStepNumber)!.autoConfigured, `step ${n}`).toBe(true);
    }
  });

  it('Pro/Premium see all 11 visible steps (12 still hidden for v1.1)', () => {
    for (const tier of ['pro', 'premium'] as const) {
      const out = listStepsForClient(tier, new Map());
      const byNum = new Map(out.steps.map((s) => [s.number, s]));

      expect(byNum.get(3)!.visible).toBe(true);
      expect(byNum.get(7)!.visible).toBe(true);
      expect(byNum.get(12)!.visible).toBe(false);
      expect(byNum.get(12)!.v11Deferred).toBe(true);
    }
  });

  it('null tier defaults to starter visibility', () => {
    const out = listStepsForClient(null, new Map());
    expect(out.clientTier).toBeNull();
    const byNum = new Map(out.steps.map((s) => [s.number, s]));
    expect(byNum.get(3)!.visible).toBe(false);
    expect(byNum.get(7)!.visible).toBe(false);
  });

  it('a saved step flips autoConfigured to false (for visible steps)', () => {
    const saved = new Map<string, WizardSavedState>([
      ['1', { hasSavedVersion: true, status: 'submitted' }],
      ['2', { hasSavedVersion: true, status: 'draft' }],
    ]);
    const out = listStepsForClient('pro', saved);
    const byNum = new Map(out.steps.map((s) => [s.number, s]));
    expect(byNum.get(1)!.autoConfigured).toBe(false);
    expect(byNum.get(2)!.autoConfigured).toBe(false);
    // Unsaved visible step still autoConfigured.
    expect(byNum.get(4)!.autoConfigured).toBe(true);
  });
});

describe('listStepsForOperator — operator view', () => {
  it('always returns 12 entries with visible=true regardless of cliente tier', () => {
    const tiersToTry: (WizardTier | null)[] = ['starter', 'pro', 'premium', null];
    for (const tier of tiersToTry) {
      const out = listStepsForOperator('client-1', tier, new Map());
      expect(out.steps.length).toBe(12);
      for (const s of out.steps) {
        expect(s.visible, `tier=${tier} step=${s.number}`).toBe(true);
      }
    }
  });

  it('autoConfigured on a step flips to true when the cliente tier hides it', () => {
    const out = listStepsForOperator('client-1', 'starter', new Map());
    const byNum = new Map(out.steps.map((s) => [s.number, s]));
    expect(byNum.get(3)!.autoConfigured).toBe(true);
    expect(byNum.get(7)!.autoConfigured).toBe(true);
    // Step 12 is always "Próximamente" — autoConfigured is not meaningful
    // for the operator (we keep it as true to surface the deferred state).
    expect(byNum.get(12)!.autoConfigured).toBe(true);
  });

  it('Pro cliente — operator autoConfigured reflects saved data', () => {
    const saved = new Map<string, WizardSavedState>([
      ['1', { hasSavedVersion: true }],
    ]);
    const out = listStepsForOperator('client-1', 'pro', saved);
    const byNum = new Map(out.steps.map((s) => [s.number, s]));
    // Step 1: Pro sees it, cliente has saved → autoConfigured = false.
    expect(byNum.get(1)!.autoConfigured).toBe(false);
    // Step 3: Pro sees it, no saved yet → autoConfigured = true (bot
    // runs on catalog default).
    expect(byNum.get(3)!.autoConfigured).toBe(true);
    // Step 4: Pro sees it, no saved yet → autoConfigured = true.
    expect(byNum.get(4)!.autoConfigured).toBe(true);
  });
});

describe('resolveClientStep — single step', () => {
  it('Starter Step 3 returns catalog defaults with autoConfigured=true', () => {
    const out = resolveClientStep(3, 'starter', emptySaved, null);
    expect(out.visibleForTier).toBe(false);
    expect(out.autoConfigured).toBe(true);
    expect(out.effectivePayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
    expect(out.savedPayload).toBeNull();
    expect(out.defaultPayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
    expect(out.v11Deferred).toBe(false);
  });

  it('Starter Step 7 returns catalog defaults', () => {
    const out = resolveClientStep(7, 'starter', emptySaved, null);
    expect(out.visibleForTier).toBe(false);
    expect(out.effectivePayload).toEqual({ reglas: [], fallback_sin_respuesta: 'derivar' });
  });

  it('Pro Step 3 returns saved payload when present, else default', () => {
    const savedPayload = { servicios: [{ nombre: 'Consulta' }], precio_tipo: 'fijo' };
    const saved: WizardSavedState = { hasSavedVersion: true, status: 'approved' };

    const withData = resolveClientStep(3, 'pro', saved, savedPayload);
    expect(withData.visibleForTier).toBe(true);
    expect(withData.autoConfigured).toBe(false);
    expect(withData.effectivePayload).toEqual(savedPayload);
    expect(withData.savedPayload).toEqual(savedPayload);

    const withoutData = resolveClientStep(3, 'pro', emptySaved, null);
    expect(withoutData.visibleForTier).toBe(true);
    expect(withoutData.autoConfigured).toBe(true);
    expect(withoutData.effectivePayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
  });

  it('Step 12 always returns default (empty) payload with v11Deferred=true', () => {
    const out = resolveClientStep(12, 'pro', emptySaved, null);
    expect(out.visibleForTier).toBe(false);
    expect(out.v11Deferred).toBe(true);
    expect(out.autoConfigured).toBe(true);
  });
});

describe('resolveOperatorStep — single step', () => {
  it('returns all 12 entries with visibleForTier=true, regardless of cliente tier', () => {
    for (const n of WIZARD_STEP_NUMBERS) {
      const out = resolveOperatorStep(n, 'c1', 'starter', emptySaved, null);
      expect(out.visibleForTier).toBe(true);
    }
  });

  it('Starter Step 3: clienteVisibleForTier=false, autoConfigured=true', () => {
    const out = resolveOperatorStep(3, 'c1', 'starter', emptySaved, null);
    expect(out.clienteVisibleForTier).toBe(false);
    expect(out.autoConfigured).toBe(true);
    expect(out.effectivePayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
    expect(out.savedPayload).toBeNull();
  });

  it('Pro Step 3 with saved data: autoConfigured=false, effectivePayload=saved', () => {
    const savedPayload = { servicios: [{ nombre: 'A' }] };
    const out = resolveOperatorStep(3, 'c1', 'pro', { hasSavedVersion: true }, savedPayload);
    expect(out.clienteVisibleForTier).toBe(true);
    expect(out.autoConfigured).toBe(false);
    expect(out.effectivePayload).toEqual(savedPayload);
    expect(out.savedPayload).toEqual(savedPayload);
  });

  it('Step 12: editable=false (v1.1 deferred) but visible=true in operator view', () => {
    const out = resolveOperatorStep(12, 'c1', 'pro', emptySaved, null);
    expect(out.editable).toBe(false);
    expect(out.v11Deferred).toBe(true);
    expect(out.visibleForTier).toBe(true);
  });
});

describe('buildSavedStateMap', () => {
  it('returns an empty map for empty rows', () => {
    const map = buildSavedStateMap([]);
    expect(map.size).toBe(0);
  });

  it('captures the latest row per stepKey', () => {
    const map = buildSavedStateMap([
      {
        stepKey: '1',
        latest: { status: 'submitted', submittedAt: '2026-06-01T00:00:00Z', approvedAt: null, activeForBot: false },
      },
      { stepKey: '2', latest: null },
    ]);
    expect(map.get('1')?.hasSavedVersion).toBe(true);
    expect(map.get('1')?.status).toBe('submitted');
    expect(map.get('2')?.hasSavedVersion).toBe(false);
  });
});
