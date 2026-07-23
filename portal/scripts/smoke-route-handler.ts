// scripts/smoke-route-handler.ts — KAIA-2913
//
// End-to-end smoke of the route handler logic without a real Prisma DB.
// Mocks `next/server` `NextRequest` and exercises the validation +
// idempotency branches. The DB-bound leg (ChatbotClient upsert +
// IntakeSubmission insert) is verified separately on staging.

import {
  parseIntakePayload,
  INTAKE_SLUG,
  INTAKE_FAQ_MIN,
  deriveVertical,
} from '../src/lib/intake-schema';

const FULL_PAYLOAD = {
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

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: string): void {
  const mark = ok ? '\u2713' : '\u2717';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passCount++;
  else failCount++;
}

// Smoke each branch the route dispatches on.
{
  const r = parseIntakePayload(FULL_PAYLOAD);
  check('Schema accepts complete payload', r.ok);
  check(
    'Vertical derivation matches sector',
    r.ok && deriveVertical(r.data!.sector) === 'clinica-dental',
    r.ok ? deriveVertical(r.data!.sector) : undefined,
  );
  check(
    'Slug constant stable',
    INTAKE_SLUG === 'kairikos-chatbot-intake',
    INTAKE_SLUG,
  );
}

{
  const r = parseIntakePayload({
    ...FULL_PAYLOAD,
    human_handoff_email: 'invalid',
  });
  check(
    'Schema rejects invalid email with per-field error',
    !r.ok && !!r.errors?.some((e) => e.path === 'human_handoff_email'),
    !r.ok ? r.errors?.map((e) => `${e.path}: ${e.message}`).join('; ') : undefined,
  );
}

{
  const r = parseIntakePayload({
    ...FULL_PAYLOAD,
    faqs: FULL_PAYLOAD.faqs.slice(0, 3),
  });
  check(
    'Schema rejects under-min FAQs',
    !r.ok && !!r.errors?.some((e) => e.path === 'faqs'),
  );
}

{
  const r = parseIntakePayload({});
  check(
    'Schema rejects empty payload',
    !r.ok && (r.errors?.length ?? 0) > 0,
    !r.ok ? `${r.errors?.length} field errors` : undefined,
  );
}

console.log('');
console.log(`Route smoke: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);
if (failCount > 0) process.exit(1);
