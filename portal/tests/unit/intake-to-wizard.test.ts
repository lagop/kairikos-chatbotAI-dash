// =============================================================================
// WP-24 — table-driven tests for src/lib/intake-to-wizard.ts.
//
// Each field mapper gets its own table (input -> expected output, one row
// per intake option). The orchestration tests then verify the AC's
// central safety property: a step only appears in the result when its
// mapped payload actually passes that step's own Zod schema — a step
// that would seed with a missing/wrong required field is absent, not
// present-but-broken.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  mapVertical,
  mapLanguages,
  pickDefaultLanguage,
  upgradeToHttps,
  mapTono,
  mapTratamiento,
  mapComportamientoFueraHorario,
  mapIntakeToWizardSteps,
  __candidateStep2ForTests,
  __candidateStep5ForTests,
} from '@/lib/intake-to-wizard';
import { step2Schema, step5Schema } from '@/lib/wizard-schemas';
import type { IntakePayload } from '@/lib/intake-schema';

function buildFaqs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    q: `¿Pregunta número ${i + 1}?`,
    a: `Respuesta a la pregunta número ${i + 1}.`,
  }));
}

const BASE_INTAKE: IntakePayload = {
  business_name: 'Clínica Dental Orly',
  legal_name: 'Orly Dental S.L.',
  sector: 'clínica dental',
  short_description: 'Clínica dental familiar en el centro de la ciudad.',
  website_url: 'https://orlydental.example.com',
  voice_tone: 'cercano',
  pronoun: 'tú',
  language: ['español', 'inglés'],
  forbidden_words: 'No hablar de precios de la competencia.',
  business_hours_weekday: 'Lunes a viernes 9:00 a 18:00',
  business_hours_weekend: 'Cerrado',
  out_of_hours_behavior: 'dejar mensaje',
  faqs: buildFaqs(10),
  channels_enabled: ['web'],
  human_handoff_email: 'contacto@orlydental.example.com',
  human_handoff_hours: 'Lunes a viernes 9:00 a 18:00',
  escalation_triggers: 'Urgencias dentales y quejas de pacientes.',
  gdpr_responsible_email: 'dpo@orlydental.example.com',
  privacy_url: 'https://orlydental.example.com/privacidad',
};

describe('mapVertical (Step 1 field table)', () => {
  const cases: Array<[IntakePayload['sector'], string]> = [
    ['clínica dental', 'clinica'],
    ['despacho jurídico/asesoría', 'abogado'],
    ['inmobiliaria', 'inmobiliaria'],
    ['restaurante/bar', 'otro'],
    ['peluquería/estética', 'otro'],
    ['otro', 'otro'],
  ];
  it.each(cases)('%s -> %s', (sector, expected) => {
    expect(mapVertical(sector)).toBe(expected);
  });
});

describe('mapLanguages + pickDefaultLanguage (Step 1 field table)', () => {
  it('maps español and inglés, drops catalán (no wizard equivalent)', () => {
    expect(mapLanguages(['español', 'catalán', 'inglés'])).toEqual(['ES', 'EN']);
  });
  it('a catalán-only selection maps to an empty array', () => {
    expect(mapLanguages(['catalán'])).toEqual([]);
  });
  it.each([
    [['ES', 'EN'] as const, 'ES'],
    [['EN'] as const, 'EN'],
    [[] as const, undefined],
  ])('idiomas=%j -> default %s', (idiomas, expected) => {
    expect(pickDefaultLanguage([...idiomas])).toBe(expected);
  });
});

describe('upgradeToHttps (Step 1 + Step 10 field table)', () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    ['https://example.com', 'https://example.com'],
    ['http://example.com', 'https://example.com'],
    ['example.com', 'https://example.com'],
    [undefined, undefined],
    ['not a url at all', undefined],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(upgradeToHttps(input)).toBe(expected);
  });
});

describe('mapTono (Step 2 field table)', () => {
  const cases: Array<[IntakePayload['voice_tone'], 'formal' | 'cercano']> = [
    ['formal', 'formal'],
    ['cercano', 'cercano'],
    ['informal-divertido', 'cercano'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(mapTono(input)).toBe(expected);
  });
});

describe('mapTratamiento (Step 2 field table)', () => {
  const cases: Array<[IntakePayload['pronoun'], 'tu' | 'usted']> = [
    ['tú', 'tu'],
    ['usted', 'usted'],
    ['nosotros', 'usted'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(mapTratamiento(input)).toBe(expected);
  });
});

describe('mapComportamientoFueraHorario (Step 5 field table)', () => {
  const cases: Array<[IntakePayload['out_of_hours_behavior'], string]> = [
    ['derivar a humano siguiente día', 'captura_lead'],
    ['dejar mensaje', 'mensaje_personalizado'],
    ['cita automática', 'captura_lead'],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(mapComportamientoFueraHorario(input)).toBe(expected);
  });
});

describe('mapIntakeToWizardSteps — orchestration', () => {
  it('seeds steps 1, 4, 7, 8, 10 from a complete, valid intake payload', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect(Object.keys(result).sort()).toEqual(['1', '10', '4', '7', '8']);
  });

  it('step 1: vertical/idiomas/nombre_comercial map correctly and pass step1Schema', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect(result['1']).toMatchObject({
      vertical: 'clinica',
      nombre_comercial: 'Clínica Dental Orly',
      razon_social: 'Orly Dental S.L.',
      web: 'https://orlydental.example.com',
      idiomas: ['ES', 'EN'],
      idioma_por_defecto: 'ES',
    });
  });

  it('step 4: every FAQ pair maps q/a -> pregunta/respuesta', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect(result['4']?.faq_items).toHaveLength(10);
    expect(result['4']?.faq_items[0]).toEqual({
      pregunta: '¿Pregunta número 1?',
      respuesta: 'Respuesta a la pregunta número 1.',
    });
  });

  it('step 7: defaults fallback_sin_respuesta to derivar given a handoff email', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect(result['7']).toEqual({ reglas: [], fallback_sin_respuesta: 'derivar' });
  });

  it('step 8: canal_web true, canal_whatsapp false when only "web" is enabled', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect(result['8']).toEqual({ canal_web: true, canal_whatsapp: false });
  });

  it('step 8: both true when web and whatsapp are enabled', () => {
    const withWhatsapp: IntakePayload = {
      ...BASE_INTAKE,
      channels_enabled: ['web', 'whatsapp'],
      whatsapp_business_number: '+34612345678',
      whatsapp_business_verified: 'sí',
    };
    const result = mapIntakeToWizardSteps(withWhatsapp);
    expect(result['8']).toEqual({ canal_web: true, canal_whatsapp: true });
  });

  it('step 8 is unseeded when only instagram is enabled (wizard step 8 has no instagram flag)', () => {
    const instagramOnly: IntakePayload = {
      ...BASE_INTAKE,
      channels_enabled: ['instagram'],
      instagram_handle: '@orlydental',
    };
    const result = mapIntakeToWizardSteps(instagramOnly);
    expect(result['8']).toBeUndefined();
  });

  it('step 10: business_name stands in for responsable_tratamiento, email_dpo and url are mapped', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect(result['10']).toMatchObject({
      responsable_tratamiento: 'Clínica Dental Orly',
      email_dpo: 'dpo@orlydental.example.com',
      url_politica_privacidad: 'https://orlydental.example.com/privacidad',
      vertical: 'clinica',
    });
  });

  it('never includes step 2 or step 5 in the result (see module header)', () => {
    const result = mapIntakeToWizardSteps(BASE_INTAKE);
    expect('2' in result).toBe(false);
    expect('5' in result).toBe(false);
  });

  it('a business_name over step1Schema\'s 80-char limit voids step 1 without throwing', () => {
    const tooLong: IntakePayload = { ...BASE_INTAKE, business_name: 'A'.repeat(81) };
    const result = mapIntakeToWizardSteps(tooLong);
    expect(result['1']).toBeUndefined();
    // The other steps are independent — one step failing must not cascade.
    expect(result['4']).toBeDefined();
  });

  it('an unmappable website_url leaves step 1\'s optional web field empty without voiding the step', () => {
    const badUrl: IntakePayload = { ...BASE_INTAKE, website_url: undefined };
    const result = mapIntakeToWizardSteps(badUrl);
    expect(result['1']).toBeDefined();
    expect(result['1']?.web).toBeUndefined();
  });
});

describe('candidate step 2 and step 5 — confirms they genuinely fail validation today, not silently succeed', () => {
  it('step 2 candidate fails step2Schema: no source for a checklist selection', () => {
    const candidate = __candidateStep2ForTests(BASE_INTAKE);
    const parsed = step2Schema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  it('step 5 candidate fails step5Schema: no source for structured horario', () => {
    const candidate = __candidateStep5ForTests(BASE_INTAKE);
    const parsed = step5Schema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });
});
