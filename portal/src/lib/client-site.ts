import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { isMultiInstanceProduct } from './client-product-access';
import { CHATBOT_PRODUCT_CODE } from './wizard-catalog';
import { logError } from './observability';

// =============================================================================
// Fase 4 multi-instancia — los sitios (negocios) del cliente, y a cuál apunta
// cada contratación.
//
// La fase 1 creó ClientSite y un backfill dio un sitio primario a cada
// cliente que EXISTÍA. Pero ninguno de los tres caminos que crean clientes
// (alta pública, autoservicio, alta de operador) creaba uno después, así que
// los clientes nuevos nacían sin sitio primario: incumplían la invariante
// "un sitio primario por cliente" que la propia fase 1 impuso con un índice
// parcial. No rompía nada visible —todo cae al nombre del cliente—, que es
// justo por lo que no se había notado.
//
// Y faltaba la otra mitad: una SEGUNDA contratación de un producto
// multi-instancia (un segundo chatbot, una segunda web de SEO) colgaba del
// sitio primario, así que aparecía con el mismo nombre que la primera en
// cada selector y el bot firmaba con el nombre del otro negocio. Ahora recibe
// su propio sitio, con un nombre provisional que el cliente sustituye al
// rellenar el asistente (ver syncSiteFromWizardIdentity).
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

/** Idempotente: si el cliente ya tiene sitio primario, lo devuelve. El índice
 *  único parcial (client_site_one_primary_per_client) es la garantía de
 *  verdad; esto evita chocar con él en el camino normal. */
export async function ensurePrimaryClientSite(
  db: Db,
  input: { clientId: string; tenantId: string | null; name: string; siteUrl?: string | null },
): Promise<{ id: string }> {
  const existing = await db.clientSite.findFirst({
    where: { clientId: input.clientId, isPrimary: true },
    select: { id: true },
  });
  if (existing) return existing;
  return db.clientSite.create({
    data: {
      clientId: input.clientId,
      tenantId: input.tenantId,
      name: input.name.trim() || 'Mi negocio',
      siteUrl: input.siteUrl?.trim() || null,
      isPrimary: true,
    },
    select: { id: true },
  });
}

/**
 * A qué sitio apunta una contratación recién creada.
 *
 * - Producto de un contrato por cliente, o primera contratación de uno
 *   multi-instancia → el sitio primario.
 * - Segunda o siguiente de un producto multi-instancia → un sitio NUEVO, con
 *   nombre provisional ("Clínica Orly (2)"). Es la misma empresa comprando
 *   para otro negocio, así que el nombre de la empresa es el mejor punto de
 *   partida, y el número evita que dos selectores digan lo mismo.
 *
 * No toca una contratación que ya tenga sitio: reactivar una contratación no
 * debe moverla de negocio.
 */
export async function assignSiteToNewContract(
  db: Db,
  input: {
    clientId: string;
    tenantId: string | null;
    clientProductId: string;
    productCode: string;
  },
): Promise<{ clientSiteId: string }> {
  const current = await db.clientProduct.findUnique({
    where: { id: input.clientProductId },
    select: { clientSiteId: true },
  });
  if (current?.clientSiteId) return { clientSiteId: current.clientSiteId };

  // El nombre de la empresa: para el primario si faltara, y como base del
  // provisional de un negocio nuevo.
  const client = await db.chatbotClient.findUnique({
    where: { id: input.clientId },
    select: { companyName: true, name: true },
  });
  const clientName = client?.companyName?.trim() || client?.name?.trim() || 'Mi negocio';

  const primary = await ensurePrimaryClientSite(db, {
    clientId: input.clientId,
    tenantId: input.tenantId,
    name: clientName,
  });

  let siteId = primary.id;
  if (isMultiInstanceProduct(input.productCode)) {
    // Cuántas contrataciones de este producto tiene ya, sin contar ésta. Ni
    // las canceladas ni las que esperan un pago que quizá no llegue: ninguna
    // de las dos ocupa un negocio.
    const siblings = await db.clientProduct.count({
      where: {
        clientId: input.clientId,
        id: { not: input.clientProductId },
        status: { notIn: ['cancelled', 'pending_payment'] },
        product: { code: input.productCode },
      },
    });
    if (siblings > 0) {
      const created = await db.clientSite.create({
        data: {
          clientId: input.clientId,
          tenantId: input.tenantId,
          name: `${clientName} (${siblings + 1})`,
          isPrimary: false,
        },
        select: { id: true },
      });
      siteId = created.id;
    }
  }

  await db.clientProduct.update({
    where: { id: input.clientProductId },
    data: { clientSiteId: siteId },
  });
  return { clientSiteId: siteId };
}

/** Qué paso del asistente del chatbot nombra el negocio. */
export const IDENTITY_STEP_KEY = '1';

/**
 * El paso 1 del asistente del chatbot pide `nombre_comercial` y `web`: es
 * donde el cliente ya nombra su negocio. Cuando se APRUEBA, el sitio de ese
 * chatbot toma esos datos, y con ellos firma el bot y se rotula cada selector.
 * Solo al aprobarse, igual que todo lo que llega al bot: un borrador no debe
 * cambiar cómo se presenta el negocio.
 *
 * Recibe el id del paso aprobado y lee él mismo su payload y su chatbot: la
 * aprobación puede llegar sin clientProductId (cliente con un solo chatbot),
 * pero la fila del paso siempre lo lleva.
 *
 * Nunca lanza: corre después de que la aprobación confirme, y renombrar un
 * negocio no puede convertir una aprobación hecha en un error para el operador.
 */
export async function syncSiteFromWizardIdentity(db: Db, input: { stepId: string }): Promise<void> {
  try {
    const step = await db.chatbotConfigStep.findUnique({
      where: { id: input.stepId },
      select: { stepKey: true, productCode: true, payload: true, clientProductId: true, clientId: true },
    });
    if (!step || step.productCode !== CHATBOT_PRODUCT_CODE || step.stepKey !== IDENTITY_STEP_KEY) return;
    if (!step.clientProductId) return;

    const payload = step.payload as Record<string, unknown> | null;
    const name = typeof payload?.nombre_comercial === 'string' ? payload.nombre_comercial.trim() : '';
    const web = typeof payload?.web === 'string' ? payload.web.trim() : '';
    if (!name && !web) return;

    const contract = await db.clientProduct.findUnique({
      where: { id: step.clientProductId },
      select: { clientSiteId: true },
    });
    if (!contract?.clientSiteId) return;

    await db.clientSite.update({
      where: { id: contract.clientSiteId },
      data: {
        ...(name ? { name } : {}),
        ...(web ? { siteUrl: web } : {}),
      },
    });
  } catch (err) {
    logError('client_site.sync_from_wizard', err, { stepId: input.stepId, product: CHATBOT_PRODUCT_CODE }, 'warn');
  }
}
