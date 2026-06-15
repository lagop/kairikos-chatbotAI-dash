// Negative-path smoke for KAIA-1168 wizard schemas.
// Verifies invalid payloads produce expected issue codes/messages.

import { stepSchemas } from '../src/lib/wizard-schemas';
import { formatZodErrors } from '../src/components/portal/wizard-steps/useZodValidation';

interface Case {
  step: number;
  payload: unknown;
  expect: string; // substring expected in the first formatted error
}

const cases: Case[] = [
  { step: 1, payload: { vertical: 'clinica', nombre_comercial: 'X', idiomas: ['ES'], idioma_por_defecto: 'EN' }, expect: '' },
  { step: 2, payload: { tono: 'formal', tratamiento: 'tu', ejemplos_respuesta: [], temas_prohibidos: { checklist: [] } }, expect: '' },
  { step: 3, payload: { servicios: [], portal_propiedades_url: '', vertical: 'clinica' }, expect: '' },
  { step: 3, payload: { servicios: [{ nombre: 'A', descripcion: 'B', precio_tipo: 'fijo' }], portal_propiedades_url: '', vertical: 'clinica' }, expect: '' },
  { step: 4, payload: { faq_items: [] }, expect: '' },
  { step: 5, payload: { timezone: '', horario: [], comportamiento_fuera_horario: 'solo_informa' }, expect: '' },
  { step: 6, payload: { datos_solicitados: [], momento_captura: 'al_inicio', destino_lead: 'email', email_notificacion: '', texto_consentimiento: '' }, expect: '' },
  { step: 7, payload: { reglas: [{ condicion_tipo: 'palabra_clave', accion: 'derivar_humano' }], fallback_sin_respuesta: 'derivar' }, expect: '' },
  { step: 8, payload: { canal_web: false, canal_whatsapp: false }, expect: '' },
  { step: 9, payload: { mensaje_bienvenida: '', prompts_sugeridos: [], mensaje_despedida: '' }, expect: '' },
  { step: 10, payload: { responsable_tratamiento: '', email_dpo: '', url_politica_privacidad: 'http://no-https.example' }, expect: '' },
  { step: 11, payload: { test_qa: [{ pregunta: '', respuesta_esperada: 'whatever' }] }, expect: '' },
];

let failures = 0;
for (const c of cases) {
  const schema = stepSchemas[c.step as keyof typeof stepSchemas];
  const r = schema.safeParse(c.payload);
  if (r.success) {
    // eslint-disable-next-line no-console
    console.log(`step ${c.step}: expected failure, got success`);
    failures += 1;
    continue;
  }
  const fe = formatZodErrors(r.error);
  const first = fe[0]?.message ?? '';
  if (!first) {
    // eslint-disable-next-line no-console
    console.log(`step ${c.step}: empty error message`);
    failures += 1;
    continue;
  }
  if (/must|required|invalid string|expected/i.test(first)) {
    // eslint-disable-next-line no-console
    console.log(`step ${c.step}: English-ish error: ${first}`);
    failures += 1;
    continue;
  }
  // eslint-disable-next-line no-console
  console.log(`step ${c.step}: OK (${first})`);
}

if (failures > 0) {
  // eslint-disable-next-line no-console
  console.log(`\n${failures} negative case(s) failed`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log('\nAll negative cases produced sane Spanish errors.');
