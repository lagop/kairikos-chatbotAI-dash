import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { ensureRecallSubscription } from './recall-onboarding';
import { ensureSeoProfile, ensureProspectingCampaign, ensureLeadQualificationProfile } from './product-onboarding';
import { isMultiInstanceProduct } from './client-product-access';

// =============================================================================
// Activar un ClientProduct sin pasar por Stripe — un operador decide que
// el producto ya está pagado (transferencia, efectivo, lo que sea) y lo
// marca activo él mismo.
//
// Extraído de POST /api/admin/portal/client-products (WP-18), que hacía
// exactamente esto inline. Segundo llamante: la creación manual de
// clientes desde el panel (POST /api/admin/portal/clients) necesita la
// misma transacción + auditoría + enganches de onboarding por producto,
// y duplicarla habría sido la misma trampa de dos copias que se
// desincronizan en silencio que ya ha costado cara en este repo (ver
// docker-compose.yml/deploy.yml, misma sesión). La ruta original se
// refactorizó para llamar a esto en vez de llevar la lógica ella misma.
// =============================================================================

export interface ActivateProductActor {
  /** 'legacy' (cabecera KAIA_OPERATOR_API_KEY) no es una fila real de
   *  Operator — se traduce a null antes de escribir en cualquier FK. */
  operatorId: string | null;
}

export type ActivateProductResult =
  | { ok: true; clientProductId: string; productCode: string; wasReactivated: boolean }
  | { ok: false; error: 'client_not_found' | 'product_not_found' };

/**
 * Activa (o reactiva) el ClientProduct de `productId` para `clientId`,
 * escribe su fila de auditoría, y dispara el enganche de onboarding del
 * producto si tiene uno (recall/seo/prospecting/leads). Atómico: la
 * escritura del ClientProduct y su auditoría van en la misma transacción
 * (WP-18) — un cambio de acceso sin rastro de quién lo hizo no debe poder
 * pasar.
 */
export async function activateClientProductForOperator(
  prisma: PrismaClient,
  params: { clientId: string; productId: string },
  actor: ActivateProductActor,
): Promise<ActivateProductResult> {
  const { clientId, productId } = params;

  const client = await prisma.chatbotClient.findUnique({ where: { id: clientId }, select: { id: true, tenantId: true } });
  if (!client) return { ok: false, error: 'client_not_found' };

  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, isActive: true, code: true, tier: true } });
  if (!product || !product.isActive) return { ok: false, error: 'product_not_found' };

  // Los productos multi-instancia nunca reutilizan una fila existente: cada
  // alta es una contratación nueva, para otra web o negocio del cliente, con
  // su propio perfil 1:1 colgando del id del ClientProduct (WebBrief/WebQuote
  // para 'web', SeoProfile para 'seo'). Reutilizar la fila daría de alta el
  // segundo sitio encima del primero.
  //
  // La lista es compartida con el checkout y con el predicado del índice
  // único parcial — ver MULTI_INSTANCE_PRODUCT_CODES.
  const existing = isMultiInstanceProduct(product.code)
    ? null
    : await prisma.clientProduct.findFirst({
        where: { clientId, productId },
        select: { id: true, status: true },
      });

  const changedBy = actor.operatorId ?? undefined;

  const row = await prisma.$transaction(async (tx) => {
    const clientProduct = existing
      ? await tx.clientProduct.update({
          where: { id: existing.id },
          data: { status: 'active', cancelledAt: null, changedBy },
          include: { product: true },
        })
      : await tx.clientProduct.create({
          data: { clientId, productId, tenantId: client.tenantId, status: 'active', createdBy: changedBy, changedBy },
          include: { product: true },
        });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: clientProduct.id,
        clientId,
        productId,
        tenantId: client.tenantId,
        action: existing ? 'reactivate' : 'assign',
        statusBefore: existing?.status ?? null,
        statusAfter: 'active',
        actorId: actor.operatorId ?? 'operator:legacy',
      },
    });
    return clientProduct;
  });

  const operatorActor = { type: 'operator' as const, operatorId: actor.operatorId };

  if (row.product?.code === 'recall') {
    await ensureRecallSubscription(prisma, { clientId, clientProductId: row.id, tenantId: row.tenantId }, operatorActor);
  }
  if (row.product?.code === 'seo') {
    await ensureSeoProfile(prisma, { clientId, clientProductId: row.id, tenantId: row.tenantId }, operatorActor);
  }
  if (row.product?.code === 'prospecting') {
    await ensureProspectingCampaign(
      prisma,
      { clientId, clientProductId: row.id, tenantId: row.tenantId, tier: row.product.tier },
      operatorActor,
    );
  }
  if (row.product?.code === 'leads') {
    await ensureLeadQualificationProfile(prisma, { clientId, clientProductId: row.id, tenantId: row.tenantId }, operatorActor);
  }

  // product.code (del findUnique de arriba), no row.product?.code: el
  // valor devuelto por create/update solo trae el `product` anidado
  // cuando el include se resuelve de verdad (Postgres real) — en los
  // tests que mockean Prisma, el resuelto de create/update no siempre
  // lo incluye, y esto no depende de ese detalle en ningún caso.
  return { ok: true, clientProductId: row.id, productCode: product.code, wasReactivated: existing !== null };
}
