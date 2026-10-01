import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';

// =============================================================================
// Plan de precios del 01/10/2026 — la captación va INCLUIDA en Chatbot
// Premium, y para Web y Pro es un complemento de 49 €/mes.
//
// «Tiene captación» deja de ser «tiene un ClientProduct de 'leads'». Se
// decidió no fabricar un segundo ClientProduct de 'leads' a 0 € al activar
// Premium: habría que darlo de baja cuando Premium se cancela o baja de
// escalón, y son justo los caminos que no avisan si se olvidan. Con este
// filtro, el derecho existe mientras exista el Premium, y nada más.
//
// Cualquier sitio que antes preguntaba por el producto 'leads' (la bandeja,
// el aviso por correo, la clasificación, los avisos de leads parados, el
// perfil de cualificación) pregunta ahora por esto. El resto es el mismo.
//
// Módulo aparte de leads.ts a propósito: leads.ts arrastra el correo y el
// webhook al CRM, y los tests que lo mockean no deberían tener que repetir
// esta regla para seguir funcionando.
// =============================================================================

/** Escalones de chatbot que llevan la captación incluida. */
export const LEADS_INCLUDED_CHATBOT_TIERS: readonly string[] = ['premium'];

/** Las contrataciones activas que dan derecho a captación: el complemento
 *  'leads', o un chatbot de un escalón que la incluye. */
export const LEADS_ENTITLEMENT_WHERE: Prisma.ClientProductWhereInput = {
  status: 'active',
  OR: [
    { product: { code: 'leads' } },
    { product: { code: 'chatbot', tier: { in: [...LEADS_INCLUDED_CHATBOT_TIERS] } } },
  ],
};

/** Si el cliente tiene la captación, contratada aparte o incluida en su plan. */
export async function hasLeadsProduct(prisma: PrismaClient, clientId: string): Promise<boolean> {
  return (await findLeadsEntitlement(prisma, clientId)) !== null;
}

/**
 * La contratación de la que cuelga la captación de este cliente.
 *
 * El complemento 'leads' va primero: quien lo tenía antes de pasar a Premium
 * ya tiene su perfil de cualificación colgado de él, y ese es el que manda
 * mientras siga activo.
 */
export async function findLeadsEntitlement(
  prisma: PrismaClient,
  clientId: string,
): Promise<{ id: string; tenantId: string | null } | null> {
  const addon = await prisma.clientProduct.findFirst({
    where: { clientId, status: 'active', product: { code: 'leads' } },
    select: { id: true, tenantId: true },
  });
  if (addon) return addon;
  return prisma.clientProduct.findFirst({
    where: { clientId, status: 'active', product: { code: 'chatbot', tier: { in: [...LEADS_INCLUDED_CHATBOT_TIERS] } } },
    orderBy: { subscribedAt: 'asc' },
    select: { id: true, tenantId: true },
  });
}
