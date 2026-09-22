import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { TIER_LEAD_CAP } from './prospecting';

// =============================================================================
// Fase 6 — el hueco "Un hook de aprovisionamiento al activar" de "Cadena
// de entrega por producto", para los tres productos que todavía lo
// tenían: 'seo', 'prospecting' y 'leads'. Mismo hueco que 'recall' ya
// tenía y que ensureRecallSubscription (recall-onboarding.ts) cerró
// primero — este archivo replica exactamente ese patrón para los otros
// tres, que hasta ahora dependían por completo de que el cliente
// guardara su propio formulario para que la fila naciera (ver los
// comentarios "Lazily creates..." en profile/route.ts, campaign/route.ts
// y qualification/route.ts, que siguen siendo ciertos para la RUTA — el
// PATCH del cliente sigue funcionando igual con o sin este hook, porque
// las tres funciones de aquí son compare-and-swap sobre la misma unicidad
// que esas rutas ya usan).
//
// Lo que esto NO hace: no rellena ningún dato. La fila nace vacía,
// exactamente como quedaría tras "el cliente todavía no ha guardado
// nada" — la diferencia es que ahora existe desde el pago, así que
// /portal/seo, /portal/leads (perfil de prospección) y /portal/leads
// (cualificación) tienen algo real que leer en vez de una ausencia total
// de fila, y un futuro correo de arranque (no construido aquí) tendría
// sobre qué producto escribir sin depender de una carrera con el primer
// guardado del cliente.
// =============================================================================

export type EnsureProductRowActor =
  | { type: 'system'; source: string }
  | { type: 'operator'; operatorId: string };

export interface EnsureProductRowParams {
  clientId: string;
  clientProductId: string;
  tenantId: string | null;
}

export interface EnsureProductRowResult {
  /** false cuando ya existía — igual que ensureRecallSubscription, el
   *  llamante no necesita distinguir "la acabo de crear" de "ya estaba". */
  created: boolean;
  id: string;
}

/**
 * Crea el SeoProfile de un ClientProduct de 'seo' si todavía no tiene
 * uno. Nace con `status: 'onboarding'` (el default del esquema) y todo
 * lo demás en blanco — el cliente lo completa desde PATCH
 * /api/portal/seo/profile, que ahora encuentra la fila ya creada en vez
 * de tener que crearla él mismo.
 *
 * Compare-and-swap contra la unicidad de `clientProductId`: dos llamadas
 * a la vez (el webhook de Stripe y un reintento, por ejemplo) chocan en
 * el `create`, no duplican la fila.
 */
export async function ensureSeoProfile(
  prisma: PrismaClient,
  params: EnsureProductRowParams,
  actor: EnsureProductRowActor,
): Promise<EnsureProductRowResult> {
  const existing = await prisma.seoProfile.findUnique({
    where: { clientProductId: params.clientProductId },
    select: { id: true },
  });
  if (existing) return { created: false, id: existing.id };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.seoProfile.create({
        data: {
          clientId: params.clientId,
          clientProductId: params.clientProductId,
          tenantId: params.tenantId,
        },
      });
      await tx.seoProfileAudit.create({
        data: {
          profileId: row.id,
          clientId: params.clientId,
          tenantId: params.tenantId,
          action: 'created',
          before: Prisma.JsonNull,
          after: { status: row.status },
          actorType: actor.type,
          actorOperatorId: actor.type === 'operator' ? actor.operatorId : null,
          actorEmail: actor.type === 'system' ? `system:${actor.source}` : null,
        },
      });
      return row;
    });
    return { created: true, id: created.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.seoProfile.findUniqueOrThrow({
        where: { clientProductId: params.clientProductId },
        select: { id: true },
      });
      return { created: false, id: winner.id };
    }
    throw err;
  }
}

export interface EnsureProspectingCampaignParams extends EnsureProductRowParams {
  /** Product.tier del ClientProduct — decide monthlyLeadCap. Mismo
   *  mapeo que PATCH /api/portal/prospecting/campaign ya usa al crear la
   *  fila él mismo (TIER_LEAD_CAP), para que el tope nunca dependa de
   *  quién construyó la fila primero. */
  tier: string;
}

/**
 * Crea la ProspectingCampaign de un ClientProduct de 'prospecting' si
 * todavía no tiene una. `category`/`locationQuery` quedan en null —son
 * lo primero que el cliente rellena en su tarjeta de /portal/leads— y
 * `monthlyLeadCap` se fija ya desde la tarifa contratada, igual que si
 * la hubiera creado la propia ruta del cliente.
 */
export async function ensureProspectingCampaign(
  prisma: PrismaClient,
  params: EnsureProspectingCampaignParams,
  actor: EnsureProductRowActor,
): Promise<EnsureProductRowResult> {
  const existing = await prisma.prospectingCampaign.findUnique({
    where: { clientProductId: params.clientProductId },
    select: { id: true },
  });
  if (existing) return { created: false, id: existing.id };

  const monthlyLeadCap = TIER_LEAD_CAP[params.tier] ?? TIER_LEAD_CAP.solo;
  const actorId = actor.type === 'system' ? `system:${actor.source}` : actor.operatorId;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.prospectingCampaign.create({
        data: {
          clientId: params.clientId,
          clientProductId: params.clientProductId,
          tenantId: params.tenantId,
          monthlyLeadCap,
        },
      });
      await tx.prospectingCampaignAudit.create({
        data: {
          campaignId: row.id,
          clientId: params.clientId,
          tenantId: params.tenantId,
          action: 'created',
          before: Prisma.JsonNull,
          after: { monthlyLeadCap: row.monthlyLeadCap },
          actorId,
        },
      });
      return row;
    });
    return { created: true, id: created.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.prospectingCampaign.findUniqueOrThrow({
        where: { clientProductId: params.clientProductId },
        select: { id: true },
      });
      return { created: false, id: winner.id };
    }
    throw err;
  }
}

/**
 * Crea el LeadQualificationProfile de un ClientProduct de 'leads' si
 * todavía no tiene uno. Nace vacío — sin `perfilClienteIdeal`, el
 * clasificador (lead-classification-ai.ts) ya degrada a una instrucción
 * genérica, así que una fila vacía es un estado válido, no a medio
 * hacer.
 *
 * `leads` no admite varios proyectos por cliente (a diferencia de
 * 'web'): el `clientId` es único en el modelo, igual que
 * `clientProductId`, así que el compare-and-swap contra cualquiera de
 * los dos protege por igual.
 */
export async function ensureLeadQualificationProfile(
  prisma: PrismaClient,
  params: EnsureProductRowParams,
  actor: EnsureProductRowActor,
): Promise<EnsureProductRowResult> {
  const existing = await prisma.leadQualificationProfile.findUnique({
    where: { clientProductId: params.clientProductId },
    select: { id: true },
  });
  if (existing) return { created: false, id: existing.id };

  const actorEmail = actor.type === 'system' ? `system:${actor.source}` : `operator:${actor.operatorId}`;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.leadQualificationProfile.create({
        data: {
          clientId: params.clientId,
          clientProductId: params.clientProductId,
          tenantId: params.tenantId,
        },
      });
      await tx.leadQualificationProfileAudit.create({
        data: {
          profileId: row.id,
          clientId: params.clientId,
          tenantId: params.tenantId,
          action: 'created',
          before: Prisma.JsonNull,
          after: Prisma.JsonNull,
          actorEmail,
        },
      });
      return row;
    });
    return { created: true, id: created.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.leadQualificationProfile.findUniqueOrThrow({
        where: { clientProductId: params.clientProductId },
        select: { id: true },
      });
      return { created: false, id: winner.id };
    }
    throw err;
  }
}
