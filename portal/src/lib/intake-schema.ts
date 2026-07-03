import { z } from 'zod';

// =============================================================================
// KAIA-2913 — Kairikos Chatbot IA in-house intake Zod schema.
//
// Source of truth: agents/6d1963ba-5831-4dca-84cd-40acd7165b3c/instructions/
//   kaia-710-chatbot-intake/tally-form-spec.json
// Specifically the `webhook_payload_schema` block (v1.0.0). The Tally fields
// map 1:1; we just enforce min/max/regex/required semantics in TypeScript so
// the same validation runs whether the payload arrives from the in-house
// public form or from any legacy n8n Tally webhook replay.
//
// Rules mirrored from the JSON Schema:
//   * `required` array -> `.min(1)` / non-optional fields
//   * `enum`           -> `z.enum([...])`
//   * `pattern`        -> `.regex(/.../)`
//   * `minLength` / `maxLength` -> `.min().max()`
//   * `format: "uri"`  -> `.url()`
//   * `format: "email"` -> `.email()`
//   * `minItems` / `maxItems` on arrays -> `.min().max()`
//   * repeater template -> `z.object({ q, a })`
//
// Form-level invariants from `form_validations`:
//   * min_faqs: 10 (also enforced array-level)
//   * min_channels: 1
//   * whatsapp_requires_number_and_verification (cross-field, superRefine)
//   * instagram_requires_handle (cross-field, superRefine)
// =============================================================================

const SECTOR_OPTIONS = [
  'clínica dental',
  'restaurante/bar',
  'despacho jurídico/asesoría',
  'peluquería/estética',
  'inmobiliaria',
  'otro',
] as const;

const VOICE_TONE_OPTIONS = ['formal', 'cercano', 'informal-divertido'] as const;
const PRONOUN_OPTIONS = ['tú', 'usted', 'nosotros'] as const;
const LANGUAGE_OPTIONS = ['español', 'catalán', 'inglés'] as const;
const OUT_OF_HOURS_OPTIONS = [
  'derivar a humano siguiente día',
  'dejar mensaje',
  'cita automática',
] as const;
const WHATSAPP_VERIFIED_OPTIONS = ['sí', 'no'] as const;
const CHANNEL_OPTIONS = ['web', 'whatsapp', 'instagram'] as const;
const WEB_INSTALL_OPTIONS = ['WordPress', 'Shopify', 'otra', 'no lo sé'] as const;

// E.164-ish (leading +, country code, 7-15 digits total). Same regex as
// the Tally spec; loosened on the trailing count to be safe.
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export const INTAKE_FAQ_MIN = 10;
export const INTAKE_FAQ_MAX = 15;

const faqSchema = z.object({
  q: z.string().min(1, 'Pregunta requerida').max(200, 'Máx. 200 caracteres'),
  a: z
    .string()
    .min(1, 'Respuesta requerida')
    .max(800, 'Máx. 800 caracteres'),
});

export const intakePayloadSchema = z
  .object({
    business_name: z
      .string()
      .min(2, 'Mínimo 2 caracteres')
      .max(80, 'Máx. 80 caracteres'),
    legal_name: z.string().max(120).optional(),
    sector: z.enum(SECTOR_OPTIONS),
    short_description: z
      .string()
      .min(1, 'Descripción corta requerida')
      .max(280, 'Máx. 280 caracteres'),
    website_url: z
      .string()
      .url('URL inválida')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    logo_upload: z.string().url().optional(),
    voice_tone: z.enum(VOICE_TONE_OPTIONS),
    pronoun: z.enum(PRONOUN_OPTIONS),
    language: z
      .array(z.enum(LANGUAGE_OPTIONS))
      .min(1, 'Selecciona al menos un idioma'),
    forbidden_words: z.string().optional(),
    business_hours_weekday: z.string().min(1, 'Horario requerido'),
    business_hours_weekend: z.string().min(1, 'Horario requerido'),
    holidays_url_or_text: z.string().optional(),
    out_of_hours_behavior: z.enum(OUT_OF_HOURS_OPTIONS),
    faqs: z
      .array(faqSchema)
      .min(INTAKE_FAQ_MIN, `Mínimo ${INTAKE_FAQ_MIN} FAQs`)
      .max(INTAKE_FAQ_MAX, `Máximo ${INTAKE_FAQ_MAX} FAQs`),
    channels_enabled: z
      .array(z.enum(CHANNEL_OPTIONS))
      .min(1, 'Selecciona al menos un canal'),
    whatsapp_business_number: z
      .string()
      .regex(E164_REGEX, 'Formato E.164 (ej. +34612345678)')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    whatsapp_business_verified: z
      .enum(WHATSAPP_VERIFIED_OPTIONS)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    instagram_handle: z
      .string()
      .max(80)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    web_install_target: z.enum(WEB_INSTALL_OPTIONS).optional(),
    human_handoff_email: z.string().email('Email inválido'),
    human_handoff_whatsapp: z
      .string()
      .regex(E164_REGEX, 'Formato E.164 (ej. +34612345678)')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    human_handoff_hours: z.string().min(1, 'Horario requerido'),
    escalation_triggers: z
      .string()
      .min(1, 'Casos críticos requeridos'),
    gdpr_responsible_email: z.string().email('Email inválido'),
    privacy_url: z.string().url('URL inválida'),
  })
  .superRefine((data, ctx) => {
    const channels = new Set(data.channels_enabled);

    if (channels.has('whatsapp')) {
      if (!data.whatsapp_business_number) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['whatsapp_business_number'],
          message:
            'Número de WhatsApp requerido cuando el canal WhatsApp está activo',
        });
      }
      if (!data.whatsapp_business_verified) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['whatsapp_business_verified'],
          message:
            'Indica si el número está verificado en Meta Business Manager',
        });
      }
    }

    if (channels.has('instagram') && !data.instagram_handle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instagram_handle'],
        message: 'Handle de Instagram requerido cuando el canal está activo',
      });
    }
  });

export type IntakePayload = z.infer<typeof intakePayloadSchema>;

// =============================================================================
// Field-level error shape exposed by the public endpoint. Zod's default
// error tree is heavy; we project a flat list so the form UI can render
// per-field messages without re-walking the tree.
// =============================================================================

export interface IntakeFieldError {
  path: string;
  message: string;
}

export interface IntakeParseResult {
  ok: boolean;
  data?: IntakePayload;
  errors?: IntakeFieldError[];
}

export function parseIntakePayload(input: unknown): IntakeParseResult {
  const result = intakePayloadSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const errors: IntakeFieldError[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

  return { ok: false, errors };
}

export const INTAKE_VERTICAL_BY_SECTOR: Record<
  (typeof SECTOR_OPTIONS)[number],
  string
> = {
  'clínica dental': 'clinica-dental',
  'restaurante/bar': 'restauracion',
  'despacho jurídico/asesoría': 'despacho',
  'peluquería/estética': 'estetica',
  inmobiliaria: 'inmobiliaria',
  otro: 'general',
};

export const INTAKE_SLUG = 'kairikos-chatbot-intake';

export function deriveVertical(sector: (typeof SECTOR_OPTIONS)[number]): string {
  return INTAKE_VERTICAL_BY_SECTOR[sector] ?? 'general';
}