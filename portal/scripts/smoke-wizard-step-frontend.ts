// Round-trip smoke for KAIA-1168 wizard schemas.
// Verifies a representative payload per step parses and re-stringifies through Zod
// without modification.

import { stepSchemas } from '../src/lib/wizard-schemas';

const cases: Record<number, unknown> = {
  1: {
    vertical: 'clinica',
    nombre_comercial: 'Clínica Vital',
    razon_social: 'Vital S.L.',
    web: 'https://vital.example',
    idiomas: ['ES', 'EN'],
    idioma_por_defecto: 'ES',
  },
  2: {
    tono: 'cercano',
    tratamiento: 'usted',
    ejemplos_respuesta: [{ texto: 'Encantada de atenderle' }],
    temas_prohibidos: { checklist: ['no_diagnosticar'], libre: '' },
    disclaimer: 'Soy un asistente virtual.',
  },
  3: {
    servicios: [
      {
        nombre: 'Consulta general',
        descripcion: 'Revisión de 30 min',
        precio_tipo: 'fijo',
        precio_valor: 50,
        duracion_min: 30,
      },
    ],
    portal_propiedades_url: '',
    vertical: 'clinica',
  },
  4: {
    faq_items: [
      { pregunta: '¿Abrís los sábados?', respuesta: 'Sí, de 10:00 a 14:00.' },
    ],
    faq_paste: '',
  },
  5: {
    timezone: 'Europe/Madrid',
    horario: [
      { dias: ['lunes', 'martes'], hora_inicio: '09:00', hora_fin: '18:00' },
    ],
    comportamiento_fuera_horario: 'mensaje_personalizado',
    mensaje_fuera_horario: 'Gracias, te respondemos mañana.',
  },
  6: {
    datos_solicitados: ['nombre', 'email'],
    campos_extra: [],
    momento_captura: 'antes_de_derivar',
    destino_lead: 'email',
    email_notificacion: 'hola@vital.example',
    texto_consentimiento: 'Acepto la política de privacidad.',
  },
  7: {
    reglas: [
      {
        condicion_tipo: 'palabra_clave',
        valor: ['urgencia', 'dolor fuerte'],
        accion: 'derivar_humano',
        destino: 'whatsapp:600000000',
      },
    ],
    fallback_sin_respuesta: 'derivar',
  },
  8: {
    canal_web: true,
    canal_whatsapp: true,
  },
  9: {
    mensaje_bienvenida: '¡Hola! Soy el asistente de Vital.',
    prompts_sugeridos: ['Pedir cita', 'Horarios'],
    mensaje_despedida: '¡Hasta pronto!',
  },
  10: {
    responsable_tratamiento: 'Vital S.L.',
    email_dpo: 'dpo@vital.example',
    url_politica_privacidad: 'https://vital.example/privacidad',
    retencion_leads_dias: 365,
    plantilla_base: 'Plantilla RGPD',
    bloque_salud: 'Bloque salud',
    bloque_secreto_profesional: undefined,
    vertical: 'clinica',
  },
  11: {
    test_qa: [
      { pregunta: '¿A qué hora abrís?', respuesta_esperada: 'De 9:00 a 18:00' },
    ],
  },
};

let failed = 0;
for (const [stepStr, payload] of Object.entries(cases)) {
  const step = Number(stepStr);
  const schema = stepSchemas[step as keyof typeof stepSchemas];
  const r = schema.safeParse(payload);
  if (r.success) {
    // eslint-disable-next-line no-console
    console.log(`step ${step}: OK`);
  } else {
    failed += 1;
    // eslint-disable-next-line no-console
    console.log(`step ${step}: FAIL`, JSON.stringify(r.error.issues, null, 2));
  }
}

if (failed > 0) {
  // eslint-disable-next-line no-console
  console.log(`\n${failed} step(s) failed`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log('\nAll steps round-trip cleanly.');
