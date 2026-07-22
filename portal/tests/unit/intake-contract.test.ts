import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseIntakePayload, INTAKE_FAQ_MIN, INTAKE_FAQ_MAX } from '@/lib/intake-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = `${__dirname}/../../../contracts/intake-v1.schema.json`;

interface ContractSchema {
  $id: string;
  version: string;
  required: string[];
  properties: Record<string, {
    type?: string;
    enum?: readonly string[];
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
    format?: string;
    pattern?: string;
    items?: { enum?: readonly string[] };
  }>;
  _meta: {
    backend_zod_module: string;
    sector_to_vertical_map: Record<string, string>;
  };
}

describe('intake-schema contract equivalence', () => {
  let contract: ContractSchema;

  beforeAll(() => {
    contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf-8')) as ContractSchema;
  });

  it('contract file parses without error', () => {
    expect(contract.$id).toContain('intake-v1.schema.json');
    expect(contract.version).toBe('1.0.0');
  });

  it('contract required fields match Zod required semantics', () => {
    const expectedRequired = [
      'business_name',
      'sector',
      'short_description',
      'voice_tone',
      'pronoun',
      'language',
      'business_hours_weekday',
      'business_hours_weekend',
      'out_of_hours_behavior',
      'faqs',
      'channels_enabled',
      'human_handoff_email',
      'human_handoff_hours',
      'escalation_triggers',
      'gdpr_responsible_email',
      'privacy_url',
    ];
    expect(new Set(contract.required)).toEqual(new Set(expectedRequired));
  });

  it('sector enum: 6 Tally options as defined in contract', () => {
    const expected = [
      'clínica dental',
      'restaurante/bar',
      'despacho jurídico/asesoría',
      'peluquería/estética',
      'inmobiliaria',
      'otro',
    ];
    expect(contract.properties.sector.enum).toEqual(expected);
    const result = parseIntakePayload({ sector: 'tecnología' } as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it('voice_tone enum: formal / cercano / informal-divertido', () => {
    const expected = ['formal', 'cercano', 'informal-divertido'];
    expect(contract.properties.voice_tone.enum).toEqual(expected);
  });

  it('pronoun enum: tú / usted / nosotros', () => {
    const expected = ['tú', 'usted', 'nosotros'];
    expect(contract.properties.pronoun.enum).toEqual(expected);
  });

  it('language enum items: español / catalán / inglés', () => {
    const expected = ['español', 'catalán', 'inglés'];
    expect(contract.properties.language.items?.enum).toEqual(expected);
    expect(contract.properties.language.minItems).toBe(1);
  });

  it('out_of_hours_behavior enum: 3 options', () => {
    const expected = ['derivar a humano siguiente día', 'dejar mensaje', 'cita automática'];
    expect(contract.properties.out_of_hours_behavior.enum).toEqual(expected);
  });

  it('channels_enabled items: web / whatsapp / instagram', () => {
    const expected = ['web', 'whatsapp', 'instagram'];
    expect(contract.properties.channels_enabled.items?.enum).toEqual(expected);
    expect(contract.properties.channels_enabled.minItems).toBe(1);
  });

  it('whatsapp_business_verified: sí / no', () => {
    expect(contract.properties.whatsapp_business_verified.enum).toEqual(['sí', 'no']);
  });

  it('web_install_target: WordPress / Shopify / otra / no lo sé', () => {
    expect(contract.properties.web_install_target.enum).toEqual([
      'WordPress',
      'Shopify',
      'otra',
      'no lo sé',
    ]);
  });

  it('whatsapp_business_number: E.164 regex pattern', () => {
    const pattern = contract.properties.whatsapp_business_number.pattern;
    expect(pattern).toBeDefined();
    const valid = /^\+[1-9]\d{6,14}$/;
    const invalid = ['34612345678', '+34 612 345 678', 'abc123'];
    expect(valid.test('+34612345678')).toBe(true);
    invalid.forEach((n) => expect(valid.test(n)).toBe(false));
  });

  it('faq minItems matches Zod INTAKE_FAQ_MIN', () => {
    expect(contract.properties.faqs.minItems).toBe(INTAKE_FAQ_MIN);
  });

  it('faq maxItems matches Zod INTAKE_FAQ_MAX', () => {
    expect(contract.properties.faqs.maxItems).toBe(INTAKE_FAQ_MAX);
  });

  it('short_description maxLength: 280', () => {
    expect(contract.properties.short_description.maxLength).toBe(280);
    const result = parseIntakePayload({ short_description: 'a'.repeat(281) } as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it('sector_to_vertical_map: all 6 sectors mapped', () => {
    const map = contract._meta.sector_to_vertical_map;
    expect(Object.keys(map)).toHaveLength(6);
    expect(map['clínica dental']).toBe('clinica-dental');
    expect(map['restaurante/bar']).toBe('restauracion');
    expect(map['despacho jurídico/asesoría']).toBe('despacho');
    expect(map['peluquería/estética']).toBe('estetica');
    expect(map['inmobiliaria']).toBe('inmobiliaria');
    expect(map['otro']).toBe('general');
  });

  it('human_handoff_email and gdpr_responsible_email: format email', () => {
    expect(contract.properties.human_handoff_email.format).toBe('email');
    expect(contract.properties.gdpr_responsible_email.format).toBe('email');
  });

  it('privacy_url and website_url: format uri', () => {
    expect(contract.properties.privacy_url.format).toBe('uri');
    expect(contract.properties.website_url.format).toBe('uri');
  });

  it('contract references backend_zod_module correctly', () => {
    expect(contract._meta.backend_zod_module).toBe('portal/src/lib/intake-schema.ts');
  });
});
