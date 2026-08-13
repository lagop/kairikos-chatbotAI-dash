import type { IntakePayload } from './intake-schema';
import {
  step1Schema,
  step4Schema,
  step5Schema,
  step7Schema,
  step8Schema,
  step10Schema,
  type Step1Input,
  type Step4Input,
  type Step5Input,
  type Step7Input,
  type Step8Input,
  type Step10Input,
} from './wizard-schemas';
import { TIMEZONE_DEFAULT } from './wizard-templates';

// =============================================================================
// WP-24 — pure translation from an accepted intake payload to per-step
// wizard payloads.
//
// Seven of the eleven wizard steps overlap with fields the client already
// answered in `/chatbot/intake` — see docs/... (the plan artifact's table).
// This module is the one place that translation happens, and it is
// deliberately conservative: a step is only returned when its mapped
// payload passes that step's OWN Zod schema (the same one the wizard PATCH
// route enforces), via `stepNSchema.safeParse`. There is no partial-step
// output — either every required field for a step has a safe, honest
// derivation from the intake data and the whole step validates, or the
// step is entirely absent from the result and the wizard shows it
// untouched. "Sembrar a medias" (a step that LOOKS filled in but is
// actually wrong or missing a required field) is worse than not seeding
// it at all — the client would review something that was never actually
// validated.
//
// Two of the seven candidate steps (2 and 5) are included below for field
// coverage and testability, but do NOT currently produce a seedable
// result for most real payloads:
//
//   * Step 2 (Personalidad) needs `temas_prohibidos.checklist`, a
//     multi-select from a fixed list of predefined topics. The intake's
//     `forbidden_words` is one free-text paragraph — there is no reliable
//     way to turn prose into a checklist selection without guessing at
//     values the client never explicitly chose. The free text lands in
//     `temas_prohibidos.libre` (which the schema does accept), but
//     `checklist` stays empty, so step5Schema... step2Schema's own
//     `.min(1, 'checkboxRequired')` on checklist fails safeParse and the
//     step is correctly omitted.
//   * Step 5 (Horario) needs `horario`, an array of structured
//     `{dias, hora_inicio, hora_fin}` slots. The intake's
//     `business_hours_weekday` / `business_hours_weekend` are free-text
//     strings ("L-V 9 a 18h", "cerrado", "9:00-14:00" — no fixed format
//     is enforced anywhere upstream). Parsing arbitrary natural-language
//     hours into structured time slots reliably is a different, much
//     harder problem than this module solves; getting it wrong would
//     show the bot as available at hours it isn't. `comportamiento_fuera_horario`
//     is mapped and tested on its own merits, but the step as a whole
//     will not validate until a future WP adds real hours parsing (or
//     the intake form collects structured hours directly).
// =============================================================================

// ---------- Field-level mappers (each independently table-tested) ----------

const SECTOR_TO_VERTICAL: Record<IntakePayload['sector'], Step1Input['vertical']> = {
  'clínica dental': 'clinica',
  'despacho jurídico/asesoría': 'abogado',
  inmobiliaria: 'inmobiliaria',
  'restaurante/bar': 'otro',
  'peluquería/estética': 'otro',
  otro: 'otro',
};

export function mapVertical(sector: IntakePayload['sector']): Step1Input['vertical'] {
  return SECTOR_TO_VERTICAL[sector] ?? 'otro';
}

const LANGUAGE_TO_WIZARD: Partial<Record<IntakePayload['language'][number], 'ES' | 'EN' | 'DE'>> = {
  español: 'ES',
  inglés: 'EN',
  // 'catalán' has no equivalent in the wizard's idiomas enum — dropped,
  // not guessed at. A client who selected only catalán ends up with an
  // empty idiomas array, which correctly fails step1Schema's own
  // `.min(1)` and leaves the step unseeded rather than silently
  // defaulting to a language they didn't select.
};

export function mapLanguages(language: IntakePayload['language']): Array<'ES' | 'EN' | 'DE'> {
  const mapped = language.map((l) => LANGUAGE_TO_WIZARD[l]).filter((v): v is 'ES' | 'EN' | 'DE' => v !== undefined);
  return [...new Set(mapped)];
}

export function pickDefaultLanguage(idiomas: Array<'ES' | 'EN' | 'DE'>): 'ES' | 'EN' | 'DE' | undefined {
  if (idiomas.includes('ES')) return 'ES';
  return idiomas[0];
}

/** Upgrades a bare/http URL to https, since every wizard URL field requires the https:// prefix. Returns undefined for anything that still isn't a valid https URL after the upgrade. */
export function upgradeToHttps(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const withScheme = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const upgraded = withScheme.replace(/^http:\/\//, 'https://');
  try {
    const parsed = new URL(upgraded);
    return parsed.protocol === 'https:' ? upgraded : undefined;
  } catch {
    return undefined;
  }
}

const TONO_TO_WIZARD: Record<IntakePayload['voice_tone'], 'formal' | 'cercano'> = {
  formal: 'formal',
  cercano: 'cercano',
  // No wizard equivalent for a third "playful" tone — 'cercano' (the less
  // formal of the two available) is the closer of the two, but this is
  // an approximation, not a lookup. Flagged so the client corrects it if
  // "formal" was actually the better fit for their situation.
  'informal-divertido': 'cercano',
};

export function mapTono(voiceTone: IntakePayload['voice_tone']): 'formal' | 'cercano' {
  return TONO_TO_WIZARD[voiceTone];
}

const TRATAMIENTO_TO_WIZARD: Record<IntakePayload['pronoun'], 'tu' | 'usted'> = {
  tú: 'tu',
  usted: 'usted',
  // The wizard only models a binary tú/usted choice. 'nosotros' (plural
  // "we") reads as more corporate/formal in Spanish business writing, so
  // it maps to 'usted' rather than 'tu' — again an approximation the
  // client should confirm, not a literal equivalence.
  nosotros: 'usted',
};

export function mapTratamiento(pronoun: IntakePayload['pronoun']): 'tu' | 'usted' {
  return TRATAMIENTO_TO_WIZARD[pronoun];
}

const OUT_OF_HOURS_TO_WIZARD: Record<
  IntakePayload['out_of_hours_behavior'],
  'solo_informa' | 'captura_lead' | 'mensaje_personalizado'
> = {
  'derivar a humano siguiente día': 'captura_lead',
  'dejar mensaje': 'mensaje_personalizado',
  'cita automática': 'captura_lead',
};

export function mapComportamientoFueraHorario(
  value: IntakePayload['out_of_hours_behavior'],
): 'solo_informa' | 'captura_lead' | 'mensaje_personalizado' {
  return OUT_OF_HOURS_TO_WIZARD[value];
}

// ---------- Per-step mappers ----------
// Each returns a *candidate* payload — not yet validated. mapIntakeToWizardSteps()
// is the only place that runs it through the step's own Zod schema and
// decides whether the step is safe to seed.

function candidateStep1(intake: IntakePayload): unknown {
  const idiomas = mapLanguages(intake.language);
  const idioma_por_defecto = pickDefaultLanguage(idiomas);
  return {
    vertical: mapVertical(intake.sector),
    nombre_comercial: intake.business_name,
    razon_social: intake.legal_name,
    web: upgradeToHttps(intake.website_url),
    idiomas,
    idioma_por_defecto,
  };
}

function candidateStep2(intake: IntakePayload): unknown {
  return {
    tono: mapTono(intake.voice_tone),
    tratamiento: mapTratamiento(intake.pronoun),
    ejemplos_respuesta: [],
    temas_prohibidos: {
      // See the module header: no source for a checklist selection, so
      // this is deliberately left empty rather than guessed at. The step
      // will not validate without at least one checklist entry — that's
      // the intended outcome, not a bug in this mapper.
      checklist: [],
      libre: intake.forbidden_words,
    },
  };
}

function candidateStep4(intake: IntakePayload): unknown {
  return {
    faq_items: intake.faqs.map((f) => ({ pregunta: f.q, respuesta: f.a })),
  };
}

function candidateStep5(intake: IntakePayload): unknown {
  return {
    timezone: TIMEZONE_DEFAULT,
    // No structured source for `horario` — see module header. Left as an
    // empty array; step5Schema requires at least one franja, so this
    // candidate will not validate on its own. Included so
    // comportamiento_fuera_horario's mapping is still exercised and
    // table-tested, and so the step "just works" the day a future WP
    // adds real hours parsing.
    horario: [],
    comportamiento_fuera_horario: mapComportamientoFueraHorario(intake.out_of_hours_behavior),
    mensaje_fuera_horario: undefined,
  };
}

function candidateStep7(intake: IntakePayload): unknown {
  return {
    reglas: [],
    // The intake's handoff/escalation fields (human_handoff_*,
    // escalation_triggers) establish WHO to hand off to, not what the
    // bot does when it simply doesn't understand a message — the wizard
    // has no direct source field for `fallback_sin_respuesta`. Given the
    // client explicitly configured a human handoff destination, 'derivar'
    // (defer to a human) is the safest default: it can't silently drop a
    // customer's question, which either of the other two options risks.
    fallback_sin_respuesta: intake.human_handoff_email ? 'derivar' : undefined,
  };
}

function candidateStep8(intake: IntakePayload): unknown {
  const channels = new Set(intake.channels_enabled);
  return {
    canal_web: channels.has('web'),
    canal_whatsapp: channels.has('whatsapp'),
  };
}

function candidateStep10(intake: IntakePayload): unknown {
  return {
    // No dedicated "responsible party name" field in the intake — the
    // company itself is the data controller by default, and this is a
    // required field with no better source than the business name.
    responsable_tratamiento: intake.business_name,
    email_dpo: intake.gdpr_responsible_email,
    url_politica_privacidad: upgradeToHttps(intake.privacy_url),
    vertical: mapVertical(intake.sector),
  };
}

// ---------- Orchestration ----------

export type WizardStepKey = '1' | '2' | '4' | '5' | '7' | '8' | '10';

// Steps '2' and '5' are deliberately absent from this type — see the
// module header. mapIntakeToWizardSteps() never populates them today.
export interface IntakeToWizardResult {
  '1'?: Step1Input;
  '4'?: Step4Input;
  '7'?: Step7Input;
  '8'?: Step8Input;
  '10'?: Step10Input;
}

/**
 * Translates an accepted intake payload into the subset of wizard steps
 * that can be safely, honestly derived from it. A step key is present in
 * the result IFF the mapped candidate passed that step's own Zod schema —
 * callers can trust every value in the result exactly as much as they
 * trust a client-submitted draft.
 */
export function mapIntakeToWizardSteps(intake: IntakePayload): IntakeToWizardResult {
  const result: IntakeToWizardResult = {};

  const s1 = step1Schema.safeParse(candidateStep1(intake));
  if (s1.success) result['1'] = s1.data;

  // Step 2 and Step 5 are intentionally not assigned to `result` even on
  // a hypothetical future success — see IntakeToWizardResult's `never`
  // members and the module header for why.

  const s4 = step4Schema.safeParse(candidateStep4(intake));
  if (s4.success) result['4'] = s4.data;

  const s7 = step7Schema.safeParse(candidateStep7(intake));
  if (s7.success) result['7'] = s7.data;

  const s8 = step8Schema.safeParse(candidateStep8(intake));
  if (s8.success) result['8'] = s8.data;

  const s10 = step10Schema.safeParse(candidateStep10(intake));
  if (s10.success) result['10'] = s10.data;

  return result;
}

// Exported for tests that want to assert step 2 / step 5 genuinely don't
// validate today (as opposed to silently succeeding with wrong data) —
// production code should use mapIntakeToWizardSteps(), not these directly.
export const __candidateStep2ForTests = candidateStep2;
export const __candidateStep5ForTests = candidateStep5;
