import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { phonesMatch } from './prospecting-replies';

// =============================================================================
// Registrar a mano que un prospecto no quiere que se le contacte (29/09/2026).
//
// La política de privacidad publicada dice que cualquiera puede oponerse
// escribiendo a contacto@kairikos.com. Hasta hoy el portal solo se enteraba
// de una oposición cuando llegaba como respuesta por WhatsApp
// (markProspectReplied): si alguien lo pedía por teléfono o por correo, no
// había dónde apuntarlo, y la secuencia seguía mandándole seguimientos.
//
// Qué hace el botón, y por qué cada cosa:
//   - status 'descartado': es lo que saca al lead de las dos consultas de
//     envío de prospecting-contact.ts (primer contacto pide 'nuevo';
//     seguimiento, 'contactado').
//   - optedOutAt: la marca de oposición. La distingue de un descarte por
//     «no encaja», bloquea por teléfono al otro local del mismo negocio y
//     hace que el borrado por plazo (retention-purge.ts) lo reduzca al
//     mínimo en las cuentas internas.
//   - Todos los leads del cliente con el mismo teléfono: la oposición es de
//     una persona, no de un local de Google. Mismo criterio que
//     markProspectReplied, que marca a todos los que comparten número.
//
// No tiene vuelta atrás desde el portal, a propósito: deshacer una oposición
// por un clic equivocado es volver a escribir a quien pidió que no. Por eso el
// botón pide confirmación. Si hace falta deshacerla, es un caso de soporte.
//
// Un lead 'convertido' no admite oposición a la prospección: ya es cliente
// del cliente, y esa relación va por otro lado.
// =============================================================================

/** Solo prospectos, que no se hayan opuesto ya, y que no sean ya clientes. */
export function canRegisterOptOut(lead: { source: string; status: string; optedOutAt: Date | null }): boolean {
  return lead.source === 'outbound' && lead.optedOutAt === null && lead.status !== 'convertido';
}

export type RegisterOptOutResult =
  | { ok: true; leadIds: string[] }
  | { ok: false; error: 'not_found' | 'not_allowed' };

export async function registerLeadOptOut(
  prisma: PrismaClient,
  input: { clientId: string; leadId: string; actorId: string; now?: Date },
): Promise<RegisterOptOutResult> {
  const now = input.now ?? new Date();

  const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
  // 404 y no 403 para un lead de otro cliente: no se revela que existe.
  if (!lead || lead.clientId !== input.clientId) return { ok: false, error: 'not_found' };
  if (!canRegisterOptOut(lead)) return { ok: false, error: 'not_allowed' };

  const siblings = lead.contactPhone
    ? (
        await prisma.lead.findMany({
          where: {
            clientId: input.clientId,
            source: 'outbound',
            optedOutAt: null,
            status: { not: 'convertido' },
            contactPhone: { not: null },
            id: { not: lead.id },
          },
          select: { id: true, tenantId: true, status: true, discardedAt: true, contactPhone: true },
        })
      ).filter((other) => phonesMatch(other.contactPhone, lead.contactPhone))
    : [];

  const targets = [lead, ...siblings];
  await prisma.$transaction(
    targets.flatMap((target) => [
      prisma.lead.update({
        where: { id: target.id },
        data: {
          status: 'descartado',
          // Si ya estaba descartado, su fecha de descarte es la de entonces.
          discardedAt: target.discardedAt ?? now,
          optedOutAt: now,
          staleAlertSentAt: null,
        },
      }),
      prisma.leadAudit.create({
        data: {
          leadId: target.id,
          clientId: input.clientId,
          tenantId: target.tenantId,
          action: 'opted_out',
          statusBefore: target.status,
          statusAfter: 'descartado',
          actorId: input.actorId,
          changedAt: now,
        },
      }),
    ]),
  );

  return { ok: true, leadIds: targets.map((t) => t.id) };
}
