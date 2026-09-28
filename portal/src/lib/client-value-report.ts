import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { notifyFromAddress } from './email-sender';
import { logError } from './observability';

// =============================================================================
// A4 — el informe de valor semanal: qué le ha dado Kairikos a este cliente
// esta semana, en sus términos.
//
// Por qué existe, y por qué es la automatización que más protege los
// ingresos: un cliente que paga 149 € al mes y no sabe qué recibe a cambio se
// da de baja en el tercer mes. Uno que cada lunes lee "11 llamadas
// recuperadas" renueva sin pensarlo. El producto ya hace el trabajo; esto es
// contarlo.
//
// Lo que NO hace: inventar euros. El plan habla de "Z € recuperados" y la
// tentación es multiplicar llamadas por un ticket medio inventado — el mismo
// error de los 300 € por corte de pelo que ya costó un informe. Aquí solo se
// cuenta lo que de verdad ha pasado: llamadas, contactos, reseñas, leads. Si
// algún día el cliente nos dice cuánto vale su encargo medio, esa cifra se
// puede añadir; hasta entonces, mejor un número cierto que uno grande.
//
// Se manda solo si hay algo que contar. Un correo semanal diciendo "esta
// semana, nada" es la mejor forma de que alguien se plantee para qué paga.
// =============================================================================

export const VALUE_REPORT_INTERVAL_DAYS = 7;

export interface ClientValueMetrics {
  llamadasRecuperadas: number;
  resenasNuevas: number;
  leadsNuevos: number;
  conversaciones: number;
}

export function hasSomethingToTell(metrics: ClientValueMetrics): boolean {
  return (
    metrics.llamadasRecuperadas > 0 ||
    metrics.resenasNuevas > 0 ||
    metrics.leadsNuevos > 0 ||
    metrics.conversaciones > 0
  );
}

/** Puro: de las métricas al correo. Aislado para poder probar el texto sin
 *  red, y para que se lea de un vistazo qué se le está diciendo al cliente. */
export function buildValueEmail(
  businessName: string,
  metrics: ClientValueMetrics,
): { subject: string; text: string; html: string } {
  const lineas: string[] = [];
  if (metrics.llamadasRecuperadas > 0) {
    lineas.push(
      `${metrics.llamadasRecuperadas} ${metrics.llamadasRecuperadas === 1 ? 'llamada recuperada' : 'llamadas recuperadas'}`,
    );
  }
  if (metrics.leadsNuevos > 0) {
    lineas.push(`${metrics.leadsNuevos} ${metrics.leadsNuevos === 1 ? 'contacto nuevo' : 'contactos nuevos'}`);
  }
  if (metrics.resenasNuevas > 0) {
    lineas.push(`${metrics.resenasNuevas} ${metrics.resenasNuevas === 1 ? 'reseña nueva' : 'reseñas nuevas'} en Google`);
  }
  if (metrics.conversaciones > 0) {
    lineas.push(
      `${metrics.conversaciones} ${metrics.conversaciones === 1 ? 'conversación atendida' : 'conversaciones atendidas'} por el chatbot`,
    );
  }

  // El titular es la cifra más alta, que es la que se recuerda.
  const subject = `Tu semana en Kairikos: ${lineas[0]}`;
  const text = [
    `Hola ${businessName},`,
    '',
    'Esto es lo que ha pasado esta semana:',
    ...lineas.map((l) => `· ${l}`),
    '',
    'Puedes verlo todo en tu portal.',
    '',
    '— Kairikos',
  ].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(businessName)},</p>`,
    '<p>Esto es lo que ha pasado esta semana:</p>',
    `<ul>${lineas.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    '<p>Puedes verlo todo en tu portal.</p>',
    '<p>— Kairikos</p>',
  ].join('\n');

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ValueReportSweepResult {
  considered: number;
  sent: number;
  skippedNothingToTell: number;
  failed: number;
}

/** Barrido semanal. Como el resto del repo, la cadencia la decide TypeScript
 *  (`lastValueReportAt`) y no el scheduler: se puede llamar cada cinco
 *  minutos sin que nadie reciba dos correos. */
export async function sweepValueReports(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ValueReportSweepResult> {
  const corte = new Date(now.getTime() - VALUE_REPORT_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

  const clients = await prisma.chatbotClient.findMany({
    where: {
      clientProducts: { some: { status: 'active' } },
      OR: [{ lastValueReportAt: null }, { lastValueReportAt: { lt: corte } }],
    },
    select: { id: true, name: true, email: true, lastValueReportAt: true },
  });

  let sent = 0;
  let skippedNothingToTell = 0;
  let failed = 0;

  for (const client of clients) {
    // La ventana es desde el último informe, no siempre 7 días: si el barrido
    // estuvo parado tres semanas, el cliente recibe lo que pasó en esas tres,
    // no una semana suelta y dos perdidas.
    const desde = client.lastValueReportAt ?? corte;

    const [llamadas, resenas, leads, conversaciones] = await Promise.all([
      prisma.callEvent.count({ where: { clientId: client.id, startedAt: { gte: desde } } }),
      prisma.googleReview.count({ where: { clientId: client.id, createTime: { gte: desde } } }),
      prisma.lead.count({ where: { clientId: client.id, createdAt: { gte: desde } } }),
      prisma.chatbotConversation.count({ where: { clientId: client.id, startedAt: { gte: desde } } }),
    ]);

    const metrics: ClientValueMetrics = {
      llamadasRecuperadas: llamadas,
      resenasNuevas: resenas,
      leadsNuevos: leads,
      conversaciones,
    };

    if (!hasSomethingToTell(metrics)) {
      skippedNothingToTell += 1;
      // El cursor avanza igual: si no, una semana vacía haría que a la
      // siguiente se contara el doble de tiempo y el correo mintiera.
      await prisma.chatbotClient.update({
        where: { id: client.id },
        data: { lastValueReportAt: now },
      });
      continue;
    }

    const rendered = buildValueEmail(client.name ?? 'tu negocio', metrics);
    const ok = await sendValueEmail(client.email, rendered);
    if (ok) sent += 1;
    else failed += 1;

    await prisma.chatbotClient.update({ where: { id: client.id }, data: { lastValueReportAt: now } });
  }

  return { considered: clients.length, sent, skippedNothingToTell, failed };
}

async function sendValueEmail(
  to: string,
  rendered: { subject: string; text: string; html: string },
): Promise<boolean> {
  if (!to || !to.includes('@')) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  try {
    // await import y no require: el require de la trampa 4 de CLAUDE.md no
    // existe en el bundle de producción.
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({ from: notifyFromAddress(), to: [to], ...rendered });
    if (result.error) {
      logError('value_report.send_failed', new Error(result.error.message), { to }, 'warn');
      return false;
    }
    return true;
  } catch (err) {
    logError('value_report.send_failed', err, { to }, 'warn');
    return false;
  }
}
