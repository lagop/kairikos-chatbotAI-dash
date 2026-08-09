// scripts/smoke-public-intake.ts — KAIA-2913
//
// Smoke test for the POST /api/public/intake validation path. Verifies
// the Zod schema rejects bad payloads with the expected 400 + per-field
// error shape, and that a valid payload is parsed cleanly without
// hitting the database (the route refuses to start when DATABASE_URL is
// unset, which is fine for a smoke of the schema layer).
//
// Run:
//   cd portal && npx tsx scripts/smoke-public-intake.ts
//
// The script imports the schema directly so it doesn't need a running
// Next.js dev server. For an end-to-end smoke with a real DB, follow
// the acceptance criteria on KAIA-2913 (Supabase staging deploy +
// curl POST /api/public/intake with the included payload).

import {
  INTAKE_FAQ_MIN,
  parseIntakePayload,
  deriveVertical,
} from '../src/lib/intake-schema';

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  const mark = pass ? '\u2713' : '\u2717';
  const line = `${mark} ${name}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
}

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

// --- happy path -----------------------------------------------------------
{
  const r = parseIntakePayload(basePayload);
  check(
    'happy-path: full payload passes Zod validation',
    r.ok,
    r.ok ? `vertical=${deriveVertical(r.data!.sector)}` : r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

// --- 400 cases -----------------------------------------------------------
{
  const r = parseIntakePayload({ ...basePayload, business_name: 'A' });
  check(
    'reject: business_name too short',
    !r.ok && !!r.errors?.some((e) => e.path === 'business_name'),
    r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

{
  const r = parseIntakePayload({
    ...basePayload,
    faqs: basePayload.faqs.slice(0, INTAKE_FAQ_MIN - 1),
  });
  check(
    `reject: faqs under min (${INTAKE_FAQ_MIN})`,
    !r.ok && !!r.errors?.some((e) => e.path === 'faqs'),
    r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

{
  const { whatsapp_business_number: _drop, ...rest } = basePayload;
  const r = parseIntakePayload(rest);
  check(
    'reject: whatsapp channel without number',
    !r.ok &&
      !!r.errors?.some((e) => e.path === 'whatsapp_business_number'),
    r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

{
  const r = parseIntakePayload({
    ...basePayload,
    channels_enabled: ['instagram'],
    whatsapp_business_number: undefined,
    whatsapp_business_verified: undefined,
  });
  check(
    'reject: instagram channel without handle',
    !r.ok && !!r.errors?.some((e) => e.path === 'instagram_handle'),
    r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

{
  const r = parseIntakePayload({
    ...basePayload,
    human_handoff_email: 'not-an-email',
  });
  check(
    'reject: invalid human_handoff_email',
    !r.ok && !!r.errors?.some((e) => e.path === 'human_handoff_email'),
    r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

{
  const r = parseIntakePayload({ ...basePayload, sector: 'tecnología' });
  check(
    'reject: unknown sector value',
    !r.ok && !!r.errors?.some((e) => e.path === 'sector'),
    r.errors?.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}

// --- summary -------------------------------------------------------------
const passCount = results.filter((r) => r.pass).length;
const failCount = results.length - passCount;
console.log('');
console.log(`Smoke: ${passCount} passed, ${failCount} failed (${results.length} total)`);
if (failCount > 0) {
  process.exit(1);
}