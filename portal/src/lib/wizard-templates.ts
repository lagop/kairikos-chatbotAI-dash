// =============================================================================
// KAIA-1168 (FE-2) — Vertical-aware defaults for wizard fields.
//
// Spec v0.2 calls for several fields to be pre-filled with templates driven
// by `vertical` (Paso 1). The values here mirror the spec tables verbatim.
// Pure module — no I/O, no React, no Prisma.
// =============================================================================

export const TEMAS_PROHIBIDOS_BY_VERTICAL: Record<string, string[]> = {
  abogado: [
    'no_asesorar_casos',
    'no_emitir_juicios_valor',
    'no_comparar_competencia',
  ],
  clinica: [
    'no_diagnosticar',
    'no_recomendar_tratamiento',
    'no_prescribir',
  ],
  inmobiliaria: [
    'no_emitir_valoracion',
    'no_negociar_precio',
  ],
  gestoria: [
    'no_asesorar_fiscal',
    'no_emitir_dictamen',
  ],
  otro: [
    'no_comparar_competencia',
  ],
};

export const TEMAS_PROHIBIDOS_LABELS: Record<string, string> = {
  no_asesorar_casos: 'No asesorar sobre casos concretos',
  no_emitir_juicios_valor: 'No emitir juicios de valor',
  no_comparar_competencia: 'No comparar con la competencia',
  no_diagnosticar: 'No diagnosticar',
  no_recomendar_tratamiento: 'No recomendar tratamientos',
  no_prescribir: 'No prescribir medicación',
  no_emitir_valoracion: 'No emitir valoraciones',
  no_negociar_precio: 'No negociar el precio',
  no_asesorar_fiscal: 'No asesorar en materia fiscal o laboral',
  no_emitir_dictamen: 'No emitir dictámenes',
};

export const DISCLAIMER_BY_VERTICAL: Record<string, string> = {
  abogado:
    'Soy un asistente virtual y no sustituyo el consejo de un abogado. Consulta con un profesional para tu caso concreto.',
  clinica:
    'Soy un asistente virtual. No sustituyo el criterio de un profesional sanitario. Ante una urgencia, contacta con tu centro de salud.',
  inmobiliaria:
    'Soy un asistente virtual. La información sobre propiedades no constituye una oferta vinculante.',
  gestoria:
    'Soy un asistente virtual. La información facilitada es orientativa y no sustituye al asesoramiento profesional.',
  otro:
    'Soy un asistente virtual. Para temas complejos, te derivaré con una persona de nuestro equipo.',
};

export const MENSAJE_BIENVENIDA_TEMPLATE: string =
  '¡Hola! Soy el asistente virtual de {nombre_comercial}. ¿En qué puedo ayudarte?';

export const TIMEZONE_DEFAULT = 'Atlantic/Canary';
export const HORARIO_DEFAULT_DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];
export const HORARIO_DEFAULT_INICIO = '09:00';
export const HORARIO_DEFAULT_FIN = '18:00';
