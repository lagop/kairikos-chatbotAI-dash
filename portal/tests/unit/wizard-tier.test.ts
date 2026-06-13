// =============================================================================
// KAIA-1166 — Unit tests for src/lib/wizard-tier.ts (BE-4 tier-aware layer).
//
// The visibility matrix is the contract the QA smoke and the FE will be
// built against. The tests below pin the matrix down: which steps each
// tier sees in the cliente view, that Step 12 is hidden in v1 for every
// tier, that the operator view always shows all 12 entries, and that the
// catalog defaults are stable per the v1 spec table.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEP_CATALOG,
  WIZARD_STEP_NUMBERS,
  isValidStepNumber,
  isValidStepKey,
  isVisibleForTier,
  isOperatorVisible,
  listStepsForClient,
  listStepsForOperator,
  normaliseTier,
  resolveClientStep,
  resolveOperatorStep,
  type Tier,
  type WizardStepNumber,
} from '@/lib/wizard-tier';

describe('catalog', () => {
  it('contains 12 entries, 1..12 in order', () => {
    expect(WIZARD_STEP_CATALOG).toHaveLength(12);
    expect(WIZARD_STEP_CATALOG.map((e) => e.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect([...WIZARD_STEP_NUMBERS]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('uses the step number as the canonical key', () => {
    for (const entry of WIZARD_STEP_CATALOG) {
      expect(entry.key).toBe(String(entry.number));
    }
  });

  it('freezes the catalog so accidental mutation is a no-op', () => {
    expect(Object.isFrozen(WIZARD_STEP_CATALOG)).toBe(true);
    const first = WIZARD_STEP_CATALOG[0];
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.defaultPayload)).toBe(true);
  });

  it('Step 3 default payload is servicios=[] + precio_tipo=consultar', () => {
    const step3 = WIZARD_STEP_CATALOG.find((e) => e.number === 3);
    expect(step3).toBeDefined();
    expect(step3!.defaultPayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
  });

  it('Step 7 default payload is reglas=[] + fallback_sin_respuesta=derivar', () => {
    const step7 = WIZARD_STEP_CATALOG.find((e) => e.number === 7);
    expect(step7).toBeDefined();
    expect(step7!.defaultPayload).toEqual({ reglas: [], fallback_sin_respuesta: 'derivar' });
  });
});

describe('isValidStepNumber / isValidStepKey', () => {
  it('accepts 1..12', () => {
    for (let i = 1; i <= 12; i++) {
      expect(isValidStepNumber(i)).toBe(true);
      expect(isValidStepKey(String(i))).toBe(true);
    }
  });

  it('rejects 0, 13, negatives, and non-integers', () => {
    expect(isValidStepNumber(0)).toBe(false);
    expect(isValidStepNumber(13)).toBe(false);
    expect(isValidStepNumber(-1)).toBe(false);
    expect(isValidStepNumber(1.5)).toBe(false);
    expect(isValidStepNumber(NaN)).toBe(false);
  });
});

describe('isVisibleForTier — visibility matrix per tier (cliente view)', () => {
  const STARTER_VISIBLE = [1, 2, 4, 5, 6, 8, 9, 10, 11] as const;
  const PRO_VISIBLE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
  const PREMIUM_VISIBLE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

  const allTiers: Tier[] = ['starter', 'pro', 'premium'];

  for (const tier of allTiers) {
    it(`Starter / Pro / Premium — Step 12 is hidden in v1 (tier=${tier})`, () => {
      expect(isVisibleForTier(12, tier)).toBe(false);
    });
  }

  for (const n of STARTER_VISIBLE) {
    it(`Starter sees Step ${n}`, () => {
      expect(isVisibleForTier(n, 'starter')).toBe(true);
    });
  }

  for (const n of [3, 7]) {
    it(`Starter does NOT see Step ${n} (servicios / derivación)`, () => {
      expect(isVisibleForTier(n as WizardStepNumber, 'starter')).toBe(false);
    });
  }

  for (const n of PRO_VISIBLE) {
    it(`Pro sees Step ${n}`, () => {
      expect(isVisibleForTier(n as WizardStepNumber, 'pro')).toBe(true);
    });
  }

  for (const n of PREMIUM_VISIBLE) {
    it(`Premium sees Step ${n}`, () => {
      expect(isVisibleForTier(n as WizardStepNumber, 'premium')).toBe(true);
    });
  }

  for (let n = 1 as WizardStepNumber; n <= 11; n = (n + 1) as WizardStepNumber) {
    it(`Step ${n} is visible for Pro and Premium`, () => {
      expect(isVisibleForTier(n, 'pro')).toBe(true);
      expect(isVisibleForTier(n, 'premium')).toBe(true);
    });
  }
});

describe('isOperatorVisible — operator view is tier-agnostic', () => {
  it('returns true for 1..12', () => {
    for (let n = 1; n <= 12; n++) {
      expect(isOperatorVisible(n as WizardStepNumber)).toBe(true);
    }
  });

  it('returns false for out-of-range', () => {
    expect(isOperatorVisible(0 as WizardStepNumber)).toBe(false);
    expect(isOperatorVisible(13 as WizardStepNumber)).toBe(false);
  });
});

describe('normaliseTier', () => {
  it('passes through known tiers', () => {
    expect(normaliseTier('starter')).toBe('starter');
    expect(normaliseTier('pro')).toBe('pro');
    expect(normaliseTier('premium')).toBe('premium');
  });

  it('defaults unknown / nullish values to starter', () => {
    expect(normaliseTier(null)).toBe('starter');
    expect(normaliseTier(undefined)).toBe('starter');
    expect(normaliseTier('')).toBe('starter');
    expect(normaliseTier('enterprise')).toBe('starter');
    expect(normaliseTier('STARTER')).toBe('starter'); // case-sensitive on purpose
  });
});

describe('listStepsForClient', () => {
  it('Starter returns 9 steps (1, 2, 4, 5, 6, 8, 9, 10, 11)', () => {
    const out = listStepsForClient('starter');
    expect(out.map((s) => s.number)).toEqual([1, 2, 4, 5, 6, 8, 9, 10, 11]);
  });

  it('Pro returns 11 steps (1..11)', () => {
    const out = listStepsForClient('pro');
    expect(out.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('Premium returns 11 steps (1..11)', () => {
    const out = listStepsForClient('premium');
    expect(out.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('every entry is visible=true', () => {
    for (const tier of ['starter', 'pro', 'premium'] as Tier[]) {
      for (const entry of listStepsForClient(tier)) {
        expect(entry.visible).toBe(true);
        expect(entry.autoConfigured).toBe(false);
      }
    }
  });
});

describe('listStepsForOperator', () => {
  it('returns all 12 steps for every tier', () => {
    for (const tier of ['starter', 'pro', 'premium'] as Tier[]) {
      const out = listStepsForOperator(tier);
      expect(out.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      for (const entry of out) {
        expect(entry.visible).toBe(true);
        expect(entry.tier).toBe(tier);
      }
    }
  });
});

describe('resolveClientStep', () => {
  it('Starter on Step 3 returns hidden + autoConfigured defaults', () => {
    const out = resolveClientStep(3, 'starter', null);
    expect(out.kind).toBe('hidden');
    if (out.kind === 'hidden') {
      expect(out.data.effectivePayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
      expect(out.data.autoConfigured).toBe(true);
      expect(out.data.visible).toBe(false);
      expect(out.data.savedPayload).toBeNull();
    }
  });

  it('Starter on Step 3 with a saved payload still returns hidden + autoConfigured defaults', () => {
    const out = resolveClientStep(3, 'starter', {
      payload: { servicios: ['corte'], precio_tipo: 'fijo' },
      status: 'submitted',
      version: 1,
    });
    expect(out.kind).toBe('hidden');
    if (out.kind === 'hidden') {
      // The bot runs on the default for hidden steps; the saved payload is
      // surfaced for the operator audit view but never the live bot config.
      expect(out.data.effectivePayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
      expect(out.data.autoConfigured).toBe(true);
      expect(out.data.savedPayload).toEqual({ servicios: ['corte'], precio_tipo: 'fijo' });
    }
  });

  it('Pro on Step 3 returns visible + saved payload (no autoConfigured)', () => {
    const out = resolveClientStep(3, 'pro', {
      payload: { servicios: ['corte'], precio_tipo: 'fijo' },
      status: 'submitted',
      version: 2,
    });
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.data.effectivePayload).toEqual({ servicios: ['corte'], precio_tipo: 'fijo' });
      expect(out.data.autoConfigured).toBe(false);
      expect(out.data.visible).toBe(true);
    }
  });

  it('Pro on Step 3 with no saved payload returns defaults (autoConfigured=true)', () => {
    const out = resolveClientStep(3, 'pro', null);
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.data.effectivePayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
      expect(out.data.autoConfigured).toBe(true);
      expect(out.data.visible).toBe(true);
    }
  });

  it('Starter on Step 7 returns hidden defaults', () => {
    const out = resolveClientStep(7, 'starter', null);
    expect(out.kind).toBe('hidden');
    if (out.kind === 'hidden') {
      expect(out.data.effectivePayload).toEqual({ reglas: [], fallback_sin_respuesta: 'derivar' });
    }
  });

  it('any tier on Step 12 returns hidden + empty default', () => {
    for (const tier of ['starter', 'pro', 'premium'] as Tier[]) {
      const out = resolveClientStep(12, tier, null);
      expect(out.kind).toBe('hidden');
      if (out.kind === 'hidden') {
        expect(out.data.autoConfigured).toBe(true);
        expect(out.data.visible).toBe(false);
      }
    }
  });

  it('out-of-range step number returns not_found', () => {
    expect(resolveClientStep(0 as WizardStepNumber, 'pro', null).kind).toBe('not_found');
    expect(resolveClientStep(13 as WizardStepNumber, 'pro', null).kind).toBe('not_found');
  });
});

describe('resolveOperatorStep', () => {
  it('Starter on Step 3 with no saved payload returns defaultPayload + autoConfigured=true', () => {
    const out = resolveOperatorStep(3, 'starter', null);
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.data!.savedPayload).toBeNull();
      expect(out.data!.defaultPayload).toEqual({ servicios: [], precio_tipo: 'consultar' });
      expect(out.data!.autoConfigured).toBe(true);
      expect(out.data!.tier).toBe('starter');
    }
  });

  it('Starter on Step 3 with a saved payload flips autoConfigured off', () => {
    const out = resolveOperatorStep(3, 'starter', {
      payload: { servicios: ['corte'], precio_tipo: 'fijo' },
      status: 'submitted',
      version: 1,
    });
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.data!.savedPayload).toEqual({ servicios: ['corte'], precio_tipo: 'fijo' });
      expect(out.data!.autoConfigured).toBe(false);
    }
  });

  it('Starter on Step 1 (visible) with no saved payload — autoConfigured is FALSE because the step is visible', () => {
    const out = resolveOperatorStep(1, 'starter', null);
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.data!.autoConfigured).toBe(false);
      expect(out.data!.savedPayload).toBeNull();
    }
  });

  it('Pro on Step 3 with no saved payload — autoConfigured is FALSE (step is visible to Pro)', () => {
    const out = resolveOperatorStep(3, 'pro', null);
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.data!.autoConfigured).toBe(false);
    }
  });

  it('any tier on Step 12 with no saved payload — autoConfigured is TRUE (hidden in v1)', () => {
    for (const tier of ['starter', 'pro', 'premium'] as Tier[]) {
      const out = resolveOperatorStep(12, tier, null);
      expect(out.kind).toBe('found');
      if (out.kind === 'found') {
        expect(out.data!.autoConfigured).toBe(true);
      }
    }
  });

  it('out-of-range step number returns not_found', () => {
    expect(resolveOperatorStep(0 as WizardStepNumber, 'pro', null).kind).toBe('not_found');
    expect(resolveOperatorStep(13 as WizardStepNumber, 'pro', null).kind).toBe('not_found');
  });
});
