// =============================================================================
// Plan de precios del 01/10/2026 — qué da cada pack de uso.
//
// El PRECIO no está aquí: es la fila Product de kind 'pack' (cuota de alta =
// pago único), que se crea y se cambia en Stripe desde el panel como
// cualquier otro precio. Aquí solo lo que el código necesita saber para
// abonarlo: a qué producto se suma y cuántas unidades.
//
// Sin 'server-only': lo leen también las tarjetas del portal para escribir
// «+2.000 mensajes» con la misma cifra que se abona.
// =============================================================================

export const USAGE_PACKS = {
  pack_chatbot_messages: { appliesTo: 'chatbot', units: 2000, label: '+2.000 mensajes' },
  pack_prospecting_leads: { appliesTo: 'prospecting', units: 100, label: '+100 negocios' },
} as const;

export type UsagePackCode = keyof typeof USAGE_PACKS;

export function isUsagePackCode(value: string): value is UsagePackCode {
  return Object.prototype.hasOwnProperty.call(USAGE_PACKS, value);
}
