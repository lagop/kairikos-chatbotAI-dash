// =============================================================================
// Frontera entre los identificadores de sesión de cada canal.
//
// ChatbotConversation.externalSessionId es único por cliente y lo comparten
// todos los canales. Los canales de mensajería lo construyen como
// `<canal>-<quien escribe>-<ms>` y buscan la conversación abierta por ese
// prefijo; el widget web, en cambio, manda un id que elige el propio
// navegador. Hasta el 22/09/2026 nada impedía que ese id del navegador
// empezara por `whatsapp-<teléfono>-`: desde el widget público de un negocio,
// cualquiera que supiera el teléfono de uno de sus clientes podía abrir una
// conversación que la ruta de WhatsApp tomaba después como la suya (y leer
// lo que esa persona escribía), o pedir por clave exacta una conversación de
// WhatsApp cuyo sufijo es un timestamp adivinable.
//
// Por eso un id que viene del widget no puede empezar por el prefijo de otro
// canal. Es la primera capa; la segunda es que las búsquedas filtran además
// por `channel` (chatbot-conversation.ts y las rutas /message).
// =============================================================================

export const CHANNEL_SESSION_PREFIXES = ['whatsapp-', 'telegram-', 'messenger-', 'instagram-'] as const;

/** true si el id tiene la forma reservada a un canal de mensajería. Se
 *  ignoran mayúsculas aunque `startsWith` de Prisma distinga: un id legítimo
 *  del widget nunca empieza así, y cerrar todas las variantes cuesta nada. */
export function isReservedSessionId(sessionId: string): boolean {
  const normalized = sessionId.trim().toLowerCase();
  return CHANNEL_SESSION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
