import { describe, expect, it } from 'vitest';
import {
  INTAKE_FAQ_MIN,
  parseIntakePayload,
  deriveVertical,
} from '@/lib/intake-schema';

const basePayload = {
  business_name: 'Clínica Dental Sonríe',
  sector: 'clínica dental',
  short_description: 'Clínica dental familiar en Madrid centro.',
  voice_tone: 'formal',
  pronoun: 'usted',
  language: ['español'],
  business_hours_weekday: '09:00 – 20:00',
  business_hours_weekend: 'cerrado',
  out_of_hours_behavior: 'derivar a humano siguiente día',
  faqs: Array.from({ length: INTAKE_FAQ_MIN }, (_, i) => ({
    q: `Pregunta ${i + 1}`,
    a: `Respuesta ${i + 1}`,
  })),
  channels_enabled: ['web', 'whatsapp'],
  whatsapp_business_number: '+34612345678',
  whatsapp_business_verified: 'sí',
  human_handoff_email: 'owner@sonrie.es',
  human_handoff_hours: '09:00 – 19:00 L-V',
  escalation_triggers: 'Urgencias dentales y cancelaciones',
  gdpr_responsible_email: 'dpo@sonrie.es',
  privacy_url: 'https://sonrie.es/privacidad',
};

describe('intake-schema', () => {
  it('accepts a fully populated payload with whatsapp + web channels', () => {
    const result = parseIntakePayload(basePayload);
    expect(result.ok).toBe(true);
    expect(result.data?.sector).toBe('clínica dental');
  });

  it('rejects payloads missing required FAQs minimum', () => {
    const result = parseIntakePayload({
      ...basePayload,
      faqs: basePayload.faqs.slice(0, INTAKE_FAQ_MIN - 1),
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.path === 'faqs')).toBe(true);
  });

  it('rejects payloads with whatsapp channel but no number', () => {
    const { whatsapp_business_number, ...rest } = basePayload;
    const result = parseIntakePayload(rest);
    expect(result.ok).toBe(false);
    expect(
      result.errors?.some((e) => e.path === 'whatsapp_business_number'),
    ).toBe(true);
  });

  it('rejects payloads with instagram channel but no handle', () => {
    const result = parseIntakePayload({
      ...basePayload,
      channels_enabled: ['instagram'],
      whatsapp_business_number: undefined,
      whatsapp_business_verified: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.path === 'instagram_handle')).toBe(true);
  });

  it('rejects payloads with no channels at all', () => {
    const result = parseIntakePayload({
      ...basePayload,
      channels_enabled: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.path === 'channels_enabled')).toBe(true);
  });

  it('rejects payloads with invalid email', () => {
    const result = parseIntakePayload({
      ...basePayload,
      human_handoff_email: 'not-an-email',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.path === 'human_handoff_email')).toBe(
      true,
    );
  });

  it('rejects payloads with invalid WhatsApp number', () => {
    const result = parseIntakePayload({
      ...basePayload,
      whatsapp_business_number: '34612345678',
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors?.some((e) => e.path === 'whatsapp_business_number'),
    ).toBe(true);
  });

  it('accepts E.164-formatted WhatsApp numbers', () => {
    const result = parseIntakePayload({
      ...basePayload,
      whatsapp_business_number: '+34612345678',
    });
    expect(result.ok).toBe(true);
  });

  it('derives vertical from sector', () => {
    expect(deriveVertical('clínica dental')).toBe('clinica-dental');
    expect(deriveVertical('restaurante/bar')).toBe('restauracion');
    expect(deriveVertical('despacho jurídico/asesoría')).toBe('despacho');
    expect(deriveVertical('peluquería/estética')).toBe('estetica');
    expect(deriveVertical('inmobiliaria')).toBe('inmobiliaria');
    expect(deriveVertical('otro')).toBe('general');
  });

  it('rejects unknown sector values', () => {
    const result = parseIntakePayload({
      ...basePayload,
      sector: 'tecnología',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.path === 'sector')).toBe(true);
  });

  it('rejects empty business_name', () => {
    const result = parseIntakePayload({
      ...basePayload,
      business_name: 'A',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.path === 'business_name')).toBe(true);
  });
});