import type { IntakePayload } from './intake-schema';

export type { IntakePayload };

export const INTAKE_CONTRACT_URI =
  'https://kairikos.com/contracts/intake-v1.schema.json' as const;

export const INTAKE_CONTRACT_VERSION = '1.0.0' as const;

export const INTAKE_SECTOR_OPTIONS = [
  'clínica dental',
  'restaurante/bar',
  'despacho jurídico/asesoría',
  'peluquería/estética',
  'inmobiliaria',
  'otro',
] as const;

export const INTAKE_CHANNEL_OPTIONS = ['web', 'whatsapp', 'instagram'] as const;

export const INTAKE_VOICE_TONE_OPTIONS = [
  'formal',
  'cercano',
  'informal-divertido',
] as const;

export const INTAKE_PRONOUN_OPTIONS = ['tú', 'usted', 'nosotros'] as const;

export const INTAKE_LANGUAGE_OPTIONS = [
  'español',
  'catalán',
  'inglés',
] as const;

export const INTAKE_OUT_OF_HOURS_OPTIONS = [
  'derivar a humano siguiente día',
  'dejar mensaje',
  'cita automática',
] as const;
