import type { BotConfig } from './chatbot-config';

// =============================================================================
// El aviso de privacidad cuando el bot pide datos de contacto dentro de la
// conversación (26/11/2026, hueco del plan del encargo del tratamiento).
//
// Hasta hoy la regla 7 del prompt le pedía al modelo que enseñara el
// `texto_consentimiento` del paso 6 antes de pedir los datos. Nada
// comprobaba que lo hiciera y no quedaba constancia: si alguien preguntaba
// «¿me informasteis?», la respuesta era «probablemente».
//
// Ahora no depende del modelo:
//  - En el chat de la web (widget) los datos solo se piden en el formulario,
//    que ya tiene aviso, casilla, fecha y versión (web-widget-context.ts).
//  - En WhatsApp, Instagram, Messenger y Telegram no hay formulario. Cuando
//    el bot pide los datos (`askContact`) o la persona los escribe por su
//    cuenta, el servidor añade este aviso detrás de la respuesta, una vez por
//    conversación, y guarda la fecha en ChatbotConversation.contactNoticeShownAt.
//    El texto exacto queda en el transcript, en ese mismo turno.
//
// El texto es el que el negocio aprobó en el paso 6 (`texto_consentimiento`,
// que por defecto viene del paso 10). Va en el idioma de la configuración:
// si la persona escribe en inglés, el aviso sale en español, igual que el
// resto de la configuración que el bot no traduce palabra por palabra.
//
// REDACCIÓN DEL MARCO PENDIENTE DE REVISIÓN JURÍDICA: es la primera capa del
// art. 13 RGPD, como el aviso del widget; la base del tratamiento es atender
// la consulta, no este texto.
// =============================================================================

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
// Nueve o más cifras, con espacios, puntos, guiones o paréntesis entre medias
// y un «+» delante opcional: un teléfono español o internacional. Un código
// postal (5) o un precio no llegan.
const PHONE_RE = /(?:\+|\b)\d(?:[\s.\-()]*\d){8,}/;

/** La persona ha escrito un correo o un teléfono en el mensaje. */
export function containsContactData(text: string): boolean {
  return EMAIL_RE.test(text) || PHONE_RE.test(text);
}

const FALLBACK_TEXT = 'Tus datos se usarán solo para gestionar tu consulta. Más información en la política de privacidad de nuestra web.';

/** El aviso que se añade a la respuesta. */
export function contactNoticeText(config: Pick<BotConfig, 'captacion'>, businessName: string): string {
  const raw = config.captacion?.texto_consentimiento;
  const texto = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : FALLBACK_TEXT;
  return `Sobre tus datos: si nos dejas un teléfono o un correo, ${businessName} los usará para responder a tu consulta. Condiciones: «${texto}»`;
}

/** La respuesta con el aviso detrás, separado por una línea en blanco. */
export function withContactNotice(reply: string, notice: string): string {
  return `${reply}\n\n${notice}`;
}
