// =============================================================================
// El alta de WhatsApp de recall (Coexistence) — lib/meta-signup-extras.ts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COEXISTENCE_SIGNUP_EXTRAS, recallSignupConfigId } from '@/lib/meta-signup-extras';

describe('recallSignupConfigId', () => {
  it('usa la configuración del chatbot cuando no hay una propia de recall', () => {
    expect(recallSignupConfigId({ configId: '1082430160826970', coexistenceConfigId: null })).toBe('1082430160826970');
    expect(recallSignupConfigId({ configId: '1082430160826970', coexistenceConfigId: '  ' })).toBe('1082430160826970');
  });

  it('una configuración propia de recall, si existe, manda', () => {
    expect(recallSignupConfigId({ configId: 'a', coexistenceConfigId: 'b' })).toBe('b');
  });

  it('null sin ninguna', () => {
    expect(recallSignupConfigId({ configId: null, coexistenceConfigId: null })).toBeNull();
    expect(recallSignupConfigId(null)).toBeNull();
  });
});

describe('COEXISTENCE_SIGNUP_EXTRAS', () => {
  // Sin featureType Meta nunca enseña "conectar tu app de WhatsApp Business"
  // y el alta registraría el número en la Cloud API, sacándolo del móvil.
  it('lleva el featureType que abre el flujo de Coexistence', () => {
    expect(COEXISTENCE_SIGNUP_EXTRAS).toEqual({ setup: {}, featureType: 'whatsapp_business_app_onboarding' });
  });

  it('la tarjeta de recall lo usa de verdad en FB.login', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/portal/RecallMetaConnectCard.tsx'), 'utf8');
    expect(src).toContain('extras: COEXISTENCE_SIGNUP_EXTRAS');
    expect(src).not.toMatch(/extras:\s*\{\s*setup:\s*\{\}\s*\}/);
  });
});
