import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { notifyFromAddress } from './email-sender';
import { portalBaseUrl } from './portal-base-url';
import { logError } from './observability';
import { USAGE_PACKS } from './usage-pack-catalog';

// =============================================================================
// Plan de precios del 01/10/2026 — el aviso de que el chatbot llegó al tope de
// mensajes del mes.
//
// Hasta esta fecha el bot se callaba sin avisar a nadie: el cliente se
// enteraba porque un cliente SUYO se quejaba de que no le contestaban. Ahora
// se le escribe una vez al mes (ChatbotUsage.capAlertedAt, que marca
// consumeMessageAllowance) con las dos salidas: comprar un pack o esperar al
// mes siguiente.
//
// Mismo molde que leads-email.ts: SDK cargado con await import (el bundle de
// producción no tiene require), remitente de email-sender.ts, y nunca lanza.
// =============================================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ChatbotCapEmailVars {
  businessName: string;
  cap: number;
  /** Dónde se compra el pack: la pantalla de canales de ESE chatbot. */
  url: string;
}

export function buildChatbotCapEmail(vars: ChatbotCapEmailVars): { subject: string; text: string; html: string } {
  const cap = vars.cap.toLocaleString('es-ES');
  const pack = USAGE_PACKS.pack_chatbot_messages.label;
  const subject = 'Tu chatbot ha llegado al tope de mensajes de este mes';
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `Tu chatbot ha contestado los ${cap} mensajes que incluye tu plan este mes, y desde ahora no responde a los mensajes nuevos.`,
    '',
    `Si quieres que siga contestando, puedes añadir un pack de ${pack}. Se activa en cuanto lo pagas y lo que no gastes este mes se queda para el siguiente:`,
    vars.url,
    '',
    'Si no haces nada, vuelve a contestar solo el día 1 del mes que viene.',
    '',
    '— Kairikos',
  ].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>Tu chatbot ha contestado los <strong>${escapeHtml(cap)} mensajes</strong> que incluye tu plan este mes, y desde ahora no responde a los mensajes nuevos.</p>`,
    `<p>Si quieres que siga contestando, puedes añadir un pack de ${escapeHtml(pack)}. Se activa en cuanto lo pagas y lo que no gastes este mes se queda para el siguiente.</p>`,
    `<p><a href="${escapeHtml(vars.url)}">Añadir mensajes</a></p>`,
    '<p>Si no haces nada, vuelve a contestar solo el día 1 del mes que viene.</p>',
    '<p>— Kairikos</p>',
  ].join('\n');
  return { subject, text, html };
}

/**
 * Manda el aviso al correo de la cuenta. Best-effort: si falla se registra y
 * ya. El turno de conversación que lo dispara no espera ni depende de esto.
 */
export async function notifyChatbotCapReached(
  prisma: PrismaClient,
  input: { clientId: string; clientProductId: string; cap: number },
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return;
    const client = await prisma.chatbotClient.findUnique({
      where: { id: input.clientId },
      select: { email: true, name: true, companyName: true },
    });
    if (!client?.email || !client.email.includes('@')) return;

    const url = `${portalBaseUrl()}/portal/canales?clientProductId=${encodeURIComponent(input.clientProductId)}`;
    const rendered = buildChatbotCapEmail({
      businessName: client.companyName ?? client.name,
      cap: input.cap,
      url,
    });
    const { Resend } = await import('resend');
    const result = await new Resend(apiKey).emails.send({ from: notifyFromAddress(), to: [client.email], ...rendered });
    if (result.error) {
      logError('chatbot_cap_email.send_failed', new Error(result.error.message), { clientId: input.clientId }, 'warn');
    }
  } catch (err) {
    logError('chatbot_cap_email.send_failed', err, { clientId: input.clientId }, 'warn');
  }
}
