// =============================================================================
// Unit tests for src/lib/web-brief-schema.ts — the 'web' product's
// standalone brief form validation (not the chatbot wizard's per-step
// schema registry; see prisma/schema.prisma's WebBrief model comment).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { webBriefSchema, webBriefDraftSchema } from '@/lib/web-brief-schema';

const VALID_SUBMIT = {
  businessName: 'Peluquería Aurora',
  goal: 'vender',
  pagesNeeded: ['Inicio', 'Contacto'],
  submit: true,
};

describe('webBriefSchema (submit: true)', () => {
  it('accepts a minimal valid submission', () => {
    const result = webBriefSchema.safeParse(VALID_SUBMIT);
    expect(result.success).toBe(true);
  });

  it('rejects a missing businessName', () => {
    const result = webBriefSchema.safeParse({ ...VALID_SUBMIT, businessName: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing goal', () => {
    const { goal: _goal, ...rest } = VALID_SUBMIT;
    const result = webBriefSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid goal enum value', () => {
    const result = webBriefSchema.safeParse({ ...VALID_SUBMIT, goal: 'not-a-real-goal' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty pagesNeeded array', () => {
    const result = webBriefSchema.safeParse({ ...VALID_SUBMIT, pagesNeeded: [] });
    expect(result.success).toBe(false);
  });

  it('accepts every optional field populated', () => {
    const result = webBriefSchema.safeParse({
      ...VALID_SUBMIT,
      vertical: 'peluquería',
      targetAudience: 'mujeres 25-45',
      hasExistingBrand: true,
      brandAssetsNote: 'logo en drive',
      otherPagesNote: 'Galería',
      contentProvidedBy: 'kairikos',
      desiredDomain: 'aurora.com',
      referenceWebsites: 'https://example.com — me gusta el hero',
      integrationsNeeded: ['WhatsApp'],
      otherIntegrationsNote: '',
      additionalNotes: 'sin prisa',
    });
    expect(result.success).toBe(true);
  });
});

describe('webBriefDraftSchema (submit: false)', () => {
  it('accepts an explicit empty pagesNeeded array (bug: .partial() alone kept the inner .min(1))', () => {
    // Caught clicking "Guardar borrador" on a fresh, untouched form in the
    // browser: the form always sends `pagesNeeded: []` (its initial
    // state), and a schema built via webBriefSchema.omit(...).partial()
    // still enforced pagesNeeded's original `.min(1)` whenever the key
    // was present — which it always is here — rejecting every draft save
    // before the client had checked a single page checkbox.
    const result = webBriefDraftSchema.safeParse({ submit: false, pagesNeeded: [], integrationsNeeded: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a fully empty draft', () => {
    const result = webBriefDraftSchema.safeParse({ submit: false });
    expect(result.success).toBe(true);
  });

  it('accepts a partial draft missing businessName/goal/pagesNeeded', () => {
    const result = webBriefDraftSchema.safeParse({ submit: false, vertical: 'clínica' });
    expect(result.success).toBe(true);
  });

  it('rejects submit: true through the draft schema (wrong literal)', () => {
    const result = webBriefDraftSchema.safeParse({ ...VALID_SUBMIT, submit: true });
    expect(result.success).toBe(false);
  });
});
