import 'server-only';
import { prisma } from './prisma';

// =============================================================================
// Chatbot — el tope de mensajes al mes, editable por el operador.
//
// Mismo molde que seo-settings.ts: fila única de id fijo, y si no existe se
// usan los valores por defecto de aquí. No hay variable de entorno de
// respaldo a propósito — el tope es una decisión comercial que se toca desde
// la pantalla de ajustes, no algo que deba cambiar al reiniciar el stack.
//
// DE DÓNDE SALEN LOS NÚMEROS. Una respuesta del bot cuesta una llamada al
// modelo con la configuración aprobada, el material de la base de
// conocimiento y hasta 20 turnos de historial: del orden de 4.000 tokens de
// entrada y 250 de salida, que con claude-haiku-4-5 son unos 0,005 € por
// mensaje. Los topes se eligieron para que el PEOR mes posible de cada tarifa
// se quede en torno al 10-15% de lo que esa tarifa cobra:
//
//   starter  99 €/mes →  2.000 mensajes ≈ 10 € de IA
//   pro     249 €/mes →  6.000 mensajes ≈ 30 €
//   premium 499 €/mes → 15.000 mensajes ≈ 75 €
//
// El uso normal queda muy por debajo: el tope no está para el cliente que
// usa mucho su bot, está para que un bucle o un abuso no lleguen a factura.
// Si el modelo o su precio cambian, estos números se revisan desde la
// pantalla, no desde aquí.
// =============================================================================

/** Fila única. Mismo criterio que SEO_SETTINGS_SINGLETON_ID. */
export const CHATBOT_SETTINGS_SINGLETON_ID = '00000000-0000-4000-8000-0000000000c1';

export interface ChatbotMessageCaps {
  starter: number;
  pro: number;
  premium: number;
}

export const DEFAULT_MESSAGE_CAPS: Readonly<ChatbotMessageCaps> = Object.freeze({
  starter: 2000,
  pro: 6000,
  premium: 15000,
});

/** Un tope de 0 dejaría el producto sin servicio sin que se note por qué, y
 *  uno enorme deja de ser un tope. Los extremos se validan en la ruta. */
export const MIN_MESSAGE_CAP = 100;
export const MAX_MESSAGE_CAP = 500000;

export async function getChatbotMessageCaps(): Promise<ChatbotMessageCaps> {
  const row = await prisma.chatbotSettings.findUnique({ where: { id: CHATBOT_SETTINGS_SINGLETON_ID } });
  if (!row) return { ...DEFAULT_MESSAGE_CAPS };
  return {
    starter: row.monthlyMessageCapStarter,
    pro: row.monthlyMessageCapPro,
    premium: row.monthlyMessageCapPremium,
  };
}

export async function updateChatbotMessageCaps(caps: ChatbotMessageCaps, actorEmail: string | null): Promise<void> {
  await prisma.chatbotSettings.upsert({
    where: { id: CHATBOT_SETTINGS_SINGLETON_ID },
    create: {
      id: CHATBOT_SETTINGS_SINGLETON_ID,
      monthlyMessageCapStarter: caps.starter,
      monthlyMessageCapPro: caps.pro,
      monthlyMessageCapPremium: caps.premium,
      updatedBy: actorEmail,
    },
    update: {
      monthlyMessageCapStarter: caps.starter,
      monthlyMessageCapPro: caps.pro,
      monthlyMessageCapPremium: caps.premium,
      updatedBy: actorEmail,
    },
  });
}

/**
 * El tope de una tarifa. Una tarifa que no esté en la lista —una nueva, o un
 * dato viejo— cae en la más baja: pasarse de generoso por no reconocer un
 * texto es exactamente el fallo que un tope existe para evitar.
 */
export function capForTier(tier: string | null | undefined, caps: ChatbotMessageCaps): number {
  const key = (tier ?? '').trim().toLowerCase();
  if (key === 'premium') return caps.premium;
  if (key === 'pro') return caps.pro;
  return caps.starter;
}
