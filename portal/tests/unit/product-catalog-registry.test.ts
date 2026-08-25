// =============================================================================
// WP-15 — unit tests for src/lib/catalogs/* (the multi-product wizard
// catalog registry) and the wizard-catalog.ts deprecated-alias shim.
//
// The "snapshot against the previous file" AC is satisfied structurally
// here: chatbot.ts is a verbatim (copy-paste, unmodified) move of the old
// wizard-catalog.ts content, so this test re-asserts the known-good v1
// spec values per step — a future accidental edit to chatbot.ts (or a
// divergence between it and the wizard-catalog.ts shim) fails loudly.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  PRODUCT_CATALOGS,
  PRODUCT_CODES,
  getProductCatalog,
  parseStepKey,
  ProductCatalogError,
  type ProductCode,
} from '@/lib/catalogs';
import { WIZARD_STEP_CATALOG } from '@/lib/wizard-catalog';

describe('PRODUCT_CATALOGS', () => {
  it('has exactly the six ProductCode keys', () => {
    expect(Object.keys(PRODUCT_CATALOGS).sort()).toEqual(
      ['chatbot', 'leads', 'recall', 'reviews', 'seo', 'web'].sort(),
    );
    expect(PRODUCT_CODES).toEqual(['chatbot', 'web', 'leads', 'seo', 'reviews', 'recall']);
  });

  it('every non-chatbot product is a valid empty catalog, not omitted or throwing', () => {
    for (const code of ['web', 'leads', 'seo', 'reviews', 'recall'] as ProductCode[]) {
      const catalog = PRODUCT_CATALOGS[code];
      expect(catalog.code).toBe(code);
      expect(catalog.label).toBeTruthy();
      expect(catalog.steps).toEqual({});
      expect(catalog.stepKeys).toEqual([]);
      expect(catalog.requiredStepKeys).toEqual([]);
      expect(catalog.milestones.length).toBeGreaterThan(0);
    }
  });

  it("recall's catalog is empty BY DESIGN, not pending — its onboarding is a state machine, not a wizard", () => {
    // web/leads/seo/reviews are empty because WP-16 hasn't given them step
    // content yet. 'recall' is different: its onboarding is gated on
    // external systems (Meta's review queue, Twilio provisioning, the
    // client dialling MMI codes on his handset), which the wizard's
    // draft→submitted→approved vocabulary cannot express. That state lives
    // on RecallSubscription — see src/lib/recall.ts. If a future change
    // adds wizard steps here, it is almost certainly modelling the wrong
    // thing.
    expect(PRODUCT_CATALOGS.recall.stepKeys).toEqual([]);
    expect(PRODUCT_CATALOGS.recall.label).toBe('Recuperación de llamadas y reseñas');
  });
});

describe('PRODUCT_CATALOGS.chatbot — structural snapshot of the v1 spec', () => {
  const chatbot = PRODUCT_CATALOGS.chatbot;

  it('has 12 steps with the known labels, blocks, and requiredForReady flags', () => {
    const expected: Array<[number, string, string, boolean, boolean]> = [
      [1, 'Perfil del negocio', 'identidad', true, false],
      [2, 'Personalidad y límites', 'identidad', true, false],
      [3, 'Servicios y tarifas', 'identidad', true, false],
      [4, 'FAQ', 'identidad', true, false],
      [5, 'Horario', 'comportamiento', true, false],
      [6, 'Captación de leads', 'comportamiento', true, false],
      [7, 'Derivación', 'comportamiento', true, false],
      [8, 'Canales', 'comportamiento', false, false],
      [9, 'Mensajes', 'comportamiento', true, false],
      [10, 'Cumplimiento', 'activacion', true, false],
      [11, 'Pruebas', 'activacion', true, false],
      [12, 'Integraciones (Próximamente · v1.1)', 'activacion', false, true],
    ];
    for (const [number, label, block, requiredForReady, v11Deferred] of expected) {
      const step = chatbot.steps[number];
      expect(step, `step ${number}`).toBeDefined();
      expect(step.key).toBe(String(number));
      expect(step.label).toBe(label);
      expect(step.block).toBe(block);
      expect(step.requiredForReady).toBe(requiredForReady);
      expect(step.v11Deferred).toBe(v11Deferred);
    }
  });

  it('stepKeys are "1".."12" and requiredStepKeys exclude Step 8 and Step 12', () => {
    expect(chatbot.stepKeys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect([...chatbot.requiredStepKeys].sort()).toEqual(
      ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11'].sort(),
    );
  });

  it('Step 3 and Step 7 are hidden for starter only; Step 12 is hidden for every tier', () => {
    expect(chatbot.steps[3].visibleFor('starter')).toBe(false);
    expect(chatbot.steps[3].visibleFor('pro')).toBe(true);
    expect(chatbot.steps[3].visibleFor('premium')).toBe(true);
    expect(chatbot.steps[7].visibleFor('starter')).toBe(false);
    expect(chatbot.steps[7].visibleFor('pro')).toBe(true);
    expect(chatbot.steps[12].visibleFor('starter')).toBe(false);
    expect(chatbot.steps[12].visibleFor('pro')).toBe(false);
    expect(chatbot.steps[12].visibleFor('premium')).toBe(false);
  });

  it('every other step is visible for every tier', () => {
    for (const n of [1, 2, 4, 5, 6, 8, 9, 10, 11]) {
      expect(chatbot.steps[n].visibleFor('starter'), `step ${n} starter`).toBe(true);
      expect(chatbot.steps[n].visibleFor('pro'), `step ${n} pro`).toBe(true);
    }
  });

  it('milestones and blocks match the existing onboarding vocabulary', () => {
    expect(chatbot.milestones).toEqual(['T+0', 'T+3', 'T+7', 'T+14']);
    expect(chatbot.blocks).toEqual(['identidad', 'comportamiento', 'activacion']);
  });
});

describe('getProductCatalog / parseStepKey', () => {
  it('resolves a known product code', () => {
    expect(getProductCatalog('chatbot').code).toBe('chatbot');
  });

  it('throws ProductCatalogError for an unknown code', () => {
    expect(() => getProductCatalog('not-a-real-product')).toThrow(ProductCatalogError);
  });

  it('parseStepKey accepts a stepKey that exists in the catalog', () => {
    expect(parseStepKey(PRODUCT_CATALOGS.chatbot, '5')).toBe('5');
  });

  it('parseStepKey throws for a stepKey outside the catalog', () => {
    expect(() => parseStepKey(PRODUCT_CATALOGS.chatbot, '99')).toThrow(ProductCatalogError);
    // 'web' has zero stepKeys today — every raw value is "outside the catalog".
    expect(() => parseStepKey(PRODUCT_CATALOGS.web, '1')).toThrow(ProductCatalogError);
  });
});

describe('wizard-catalog.ts deprecated shim', () => {
  it('WIZARD_STEP_CATALOG is the literal same object as PRODUCT_CATALOGS.chatbot.steps — a true alias, not a stale copy', () => {
    expect(WIZARD_STEP_CATALOG).toBe(PRODUCT_CATALOGS.chatbot.steps);
  });
});
