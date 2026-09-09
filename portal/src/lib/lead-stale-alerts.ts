import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { isStuck, stuckThresholdDays } from './leads';
import { sendStaleLeadEmail } from './leads-email';
import { logError } from './observability';

// =============================================================================
// Fase 2.4 — avisar al equipo del CLIENTE de que tiene leads parados.
//
// La detección de leads atascados existe desde Leads Fase 5 (isStuck,
// stuckThresholdDays), pero alimentaba solo la cola de soporte del
// operador de Kairikos. Es decir: sabíamos que a un cliente se le estaban
// enfriando los leads y no se lo decíamos. Quien puede actuar es su
// comercial, no nosotros.
//
// Los umbrales NO se redefinen aquí: se reutilizan los de leads.ts (2 días
// en 'nuevo', 14 en 'contactado') para que la cola del operador y el aviso
// al cliente no puedan discrepar sobre qué está frío.
//
// Un aviso por lead y por estado: staleAlertSentAt se sella al enviar y se
// limpia cuando el lead cambia de estado (ruta PATCH del portal).
// =============================================================================

/** Cota superior de correos por tick. */
const ALERT_BATCH_SIZE = 50;

/** Como mucho un correo por cliente y barrido, agrupando sus leads
 *  parados: cinco avisos sueltos el mismo minuto se leen como spam, uno
 *  con cinco nombres se lee como una lista de tareas. */
export interface StaleAlertSweepResult {
  /** Leads abiertos que han superado su umbral y no tenían aviso. */
  stale: number;
  /** Clientes a los que se ha escrito. */
  clientsAlerted: number;
}

interface StaleLead {
  id: string;
  clientId: string;
  status: string;
  createdAt: Date;
  contactedAt: Date | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  score: number | null;
}

/** Desde cuándo lleva el lead en su estado actual — el mismo criterio que
 *  usa la cola del operador (enteredCurrentStateAt en leads.ts). */
function since(lead: StaleLead): Date {
  return lead.status === 'contactado' && lead.contactedAt ? lead.contactedAt : lead.createdAt;
}

export function describeLead(lead: StaleLead): string {
  const who = [lead.contactName, lead.contactPhone, lead.contactEmail].filter(Boolean)[0] ?? 'Sin datos de contacto';
  return lead.score !== null ? `${who} (prioridad ${lead.score})` : who;
}

export async function sweepStaleLeadAlerts(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<StaleAlertSweepResult> {
  const candidates = (await prisma.lead.findMany({
    where: {
      status: { in: ['nuevo', 'contactado'] },
      staleAlertSentAt: null,
      client: { clientProducts: { some: { status: 'active', product: { code: 'leads' } } } },
    },
    orderBy: { createdAt: 'asc' },
    take: ALERT_BATCH_SIZE,
    select: {
      id: true, clientId: true, status: true, createdAt: true, contactedAt: true,
      contactName: true, contactPhone: true, contactEmail: true, score: true,
    },
  })) as StaleLead[];

  const stale = candidates.filter((lead) => isStuck(lead.status, since(lead), now));
  if (stale.length === 0) return { stale: 0, clientsAlerted: 0 };

  // Agrupados por cliente: un correo con la lista, no uno por lead.
  const byClient = new Map<string, StaleLead[]>();
  for (const lead of stale) {
    const bucket = byClient.get(lead.clientId);
    if (bucket) bucket.push(lead);
    else byClient.set(lead.clientId, [lead]);
  }

  let clientsAlerted = 0;

  for (const [clientId, leads] of byClient) {
    const [client, qualification] = await Promise.all([
      prisma.chatbotClient.findUnique({
        where: { id: clientId },
        select: { email: true, name: true, companyName: true },
      }),
      prisma.leadQualificationProfile.findUnique({
        where: { clientId },
        select: { emailAviso: true },
      }),
    ]);
    const to = qualification?.emailAviso || client?.email;
    if (!client || !to) continue;

    const result = await sendStaleLeadEmail({
      to,
      businessName: client.companyName ?? client.name,
      leads: leads.map((lead) => ({
        description: describeLead(lead),
        status: lead.status,
        days: Math.floor((now.getTime() - since(lead).getTime()) / (24 * 60 * 60_000)),
        thresholdDays: stuckThresholdDays(lead.status) ?? 0,
      })),
    });

    if (!result.ok) {
      // Sin sellar: se reintenta en el siguiente barrido.
      logError('lead_stale_alerts.send_failed', new Error(result.error), { clientId }, 'warn');
      continue;
    }

    await prisma.lead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { staleAlertSentAt: now },
    });
    clientsAlerted += 1;
  }

  return { stale: stale.length, clientsAlerted };
}
