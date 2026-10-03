import 'server-only';
import type { GoogleBusinessConnection, PrismaClient } from '@prisma/client';
import { getValidAccessToken } from './google-business';
import { generateGbpPost } from './gbp-post-ai';
import { findReplyRisk } from './review-reply-ai';
import { createProductCheckoutSession, type CreateCheckoutSessionResult } from './stripe-billing';
import { annualPriceCents, type BillingInterval } from './annual-billing';
import { logError } from './observability';

// =============================================================================
// Plan de precios del 01/10/2026 — Ficha de Google gestionada: publicaciones
// semanales y respuestas a las reseñas, 49 €/mes o 490 €/año, UNA POR FICHA.
//
// - Respuestas: ya existía la publicación automática (autoPublishReplies, que
//   el cliente activa a mano, con su retención por riesgo). Con la Ficha
//   gestionada contratada, esa ficha se trata como si la tuviera activada:
//   ver review-reply.ts.
// - Publicaciones: nuevas. Cada semana la IA escribe un borrador
//   (gbp-post-ai.ts) y se publica solo a las POST_REVIEW_WINDOW_HOURS, salvo
//   que el cliente lo descarte o lo publique antes desde /portal/resenas. Es
//   el mismo trato que los artículos SEO (seo-draft-auto-publish.ts):
//   «publicar salvo veto». Un borrador con un teléfono, un enlace o un correo
//   (findReplyRisk) no se publica solo nunca: espera a que el cliente lo mire.
//
// Qué ficha gestiona qué contratación: GoogleBusinessConnection.
// managedClientProductId. Se ata al empezar el pago si el cliente eligió la
// ficha, o después, al conectarla, si pagó antes de tener ninguna
// (linkUnlinkedManagedContracts). Gestionada = esa contratación está activa;
// una baja no toca la ficha.
//
// LIMITACIÓN CONOCIDA (03/10/2026): la API de publicaciones de Google
// (v4 localPosts) no se ha probado contra una ficha real. El código sigue la
// documentación y el resto de llamadas v4 que sí funcionan (reseñas); el
// primer cliente real es la prueba, y un fallo queda en GbpPost.lastError con
// el estado 'publish_failed', sin reintentos que puedan duplicar.
// =============================================================================

export const GBP_MANAGED_CODE = 'gbp_managed';
export const POST_INTERVAL_DAYS = 7;
export const POST_REVIEW_WINDOW_HOURS = 48;
/** Topes por pasada: cada borrador es una llamada al modelo y cada
 *  publicación una a Google. El cron pasa cada pocos minutos. */
const MAX_DRAFTS_PER_TICK = 5;
const MAX_PUBLISHES_PER_TICK = 10;

const localPostsUrl = (connection: Pick<GoogleBusinessConnection, 'googleAccountId' | 'locationId'>) =>
  `https://mybusiness.googleapis.com/v4/${connection.googleAccountId}/${connection.locationId}/localPosts`;

/** Si esta ficha está gestionada ahora mismo. */
export async function isConnectionManaged(
  prisma: PrismaClient,
  connection: Pick<GoogleBusinessConnection, 'managedClientProductId'>,
): Promise<boolean> {
  if (!connection.managedClientProductId) return false;
  const cp = await prisma.clientProduct.findFirst({
    where: { id: connection.managedClientProductId, status: 'active', product: { code: GBP_MANAGED_CODE } },
    select: { id: true },
  });
  return cp !== null;
}

/**
 * Ata cada contratación activa que aún no gestiona ninguna ficha a la ficha
 * activa más antigua del cliente que no esté gestionada. Es el camino de
 * quien pagó antes de conectar su ficha.
 */
export async function linkUnlinkedManagedContracts(prisma: PrismaClient): Promise<number> {
  const contracts = await prisma.clientProduct.findMany({
    where: { status: 'active', product: { code: GBP_MANAGED_CODE } },
    select: { id: true, clientId: true },
  });
  if (contracts.length === 0) return 0;
  const linked = new Set(
    (
      await prisma.googleBusinessConnection.findMany({
        where: { managedClientProductId: { in: contracts.map((c) => c.id) } },
        select: { managedClientProductId: true },
      })
    ).map((c) => c.managedClientProductId),
  );

  let count = 0;
  for (const contract of contracts) {
    if (linked.has(contract.id)) continue;
    // Una ficha cuyo enlace apunta a una contratación que ya no está activa
    // cuenta como libre.
    const candidates = await prisma.googleBusinessConnection.findMany({
      where: { clientId: contract.clientId, status: 'active' },
      orderBy: { connectedAt: 'asc' },
      select: { id: true, managedClientProductId: true },
    });
    for (const candidate of candidates) {
      if (candidate.managedClientProductId && (await isConnectionManaged(prisma, candidate))) continue;
      await prisma.googleBusinessConnection.update({
        where: { id: candidate.id },
        data: { managedClientProductId: contract.id },
      });
      count += 1;
      break;
    }
  }
  return count;
}

/** Publica en Google. Nunca lanza. */
export async function publishLocalPost(
  connection: GoogleBusinessConnection,
  summary: string,
): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
  try {
    const token = await getValidAccessToken(connection);
    if (!token) return { ok: false, error: 'no_access_token' };
    const res = await fetch(localPostsUrl(connection), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ languageCode: 'es', summary, topicType: 'STANDARD' }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `google_local_posts_error:${res.status}:${detail.slice(0, 300)}` };
    }
    const json = (await res.json().catch(() => ({}))) as { name?: string };
    return { ok: true, name: json.name ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

/** El material para el borrador: lo que el negocio dice de sí mismo y lo que
 *  valoran sus clientes. */
async function gatherMaterial(prisma: PrismaClient, connection: GoogleBusinessConnection) {
  const [client, seo, praise, previous] = await Promise.all([
    prisma.chatbotClient.findUnique({ where: { id: connection.clientId }, select: { name: true, companyName: true } }),
    prisma.seoProfile.findFirst({
      where: { clientId: connection.clientId, businessDescription: { not: null } },
      select: { businessDescription: true },
    }),
    prisma.googleReview.findMany({
      where: { connectionId: connection.id, starRating: { gte: 4 }, comment: { not: null } },
      orderBy: { createTime: 'desc' },
      take: 5,
      select: { comment: true },
    }),
    prisma.gbpPost.findMany({
      where: { connectionId: connection.id, status: { in: ['published', 'drafted'] } },
      orderBy: { generatedAt: 'desc' },
      take: 4,
      select: { summary: true },
    }),
  ]);
  return {
    businessName: client?.companyName?.trim() || client?.name?.trim() || connection.locationName,
    businessDescription: seo?.businessDescription ?? null,
    recentPraise: praise.map((r) => r.comment ?? '').filter(Boolean),
    previousPosts: previous.map((p) => p.summary),
  };
}

export interface GbpManagedSweepResult {
  linked: number;
  drafted: number;
  published: number;
  failed: number;
}

/**
 * La pasada del cron: ata contratos sueltos, escribe el borrador de la semana
 * de cada ficha gestionada que no lo tenga, y publica los que cumplieron el
 * plazo. Idempotente: llamarla de más no escribe dos borradores en la misma
 * semana ni publica dos veces el mismo.
 */
export async function sweepGbpManagedPosts(prisma: PrismaClient, now: Date = new Date()): Promise<GbpManagedSweepResult> {
  const result: GbpManagedSweepResult = { linked: 0, drafted: 0, published: 0, failed: 0 };
  result.linked = await linkUnlinkedManagedContracts(prisma);

  const connections = await prisma.googleBusinessConnection.findMany({
    where: { status: 'active', managedClientProductId: { not: null } },
  });
  const weekAgo = new Date(now.getTime() - POST_INTERVAL_DAYS * 24 * 60 * 60_000);

  for (const connection of connections) {
    if (result.drafted >= MAX_DRAFTS_PER_TICK) break;
    try {
      if (!(await isConnectionManaged(prisma, connection))) continue;
      const recent = await prisma.gbpPost.findFirst({
        where: { connectionId: connection.id, generatedAt: { gt: weekAgo } },
        select: { id: true },
      });
      if (recent) continue;

      const draft = await generateGbpPost(await gatherMaterial(prisma, connection));
      if (!draft.ok || 'skipped' in draft) {
        if (!draft.ok) logError('gbp_managed.draft_failed', new Error(draft.error), { connectionId: connection.id }, 'warn');
        continue;
      }
      await prisma.gbpPost.create({
        data: {
          clientId: connection.clientId,
          tenantId: connection.tenantId,
          connectionId: connection.id,
          clientProductId: connection.managedClientProductId!,
          summary: draft.post,
          generatedAt: now,
          publishAfter: new Date(now.getTime() + POST_REVIEW_WINDOW_HOURS * 60 * 60_000),
          // Retenido: no se publica solo (ver la cabecera).
          lastError: draft.risk ? `held:${draft.risk}` : null,
        },
      });
      result.drafted += 1;
    } catch (err) {
      logError('gbp_managed.draft_item_failed', err, { connectionId: connection.id });
    }
  }

  const due = await prisma.gbpPost.findMany({
    where: { status: 'drafted', publishAfter: { lte: now } },
    orderBy: { publishAfter: 'asc' },
    take: MAX_PUBLISHES_PER_TICK * 3,
  });
  for (const post of due) {
    if (result.published + result.failed >= MAX_PUBLISHES_PER_TICK) break;
    if (post.lastError?.startsWith('held:')) continue;
    const outcome = await publishDraft(prisma, post.id, 'auto', now);
    if (outcome === 'published') result.published += 1;
    else if (outcome === 'publish_failed') result.failed += 1;
  }
  return result;
}

/**
 * Publica un borrador. Lo reclama primero (drafted → publishing implícito con
 * updateMany condicionado) para que el cron y el botón del cliente a la vez
 * no lo publiquen dos veces.
 */
export async function publishDraft(
  prisma: PrismaClient,
  postId: string,
  by: string,
  now: Date = new Date(),
): Promise<'published' | 'publish_failed' | 'not_publishable'> {
  const post = await prisma.gbpPost.findUnique({ where: { id: postId } });
  if (!post || post.status !== 'drafted') return 'not_publishable';
  const connection = await prisma.googleBusinessConnection.findUnique({ where: { id: post.connectionId } });
  if (!connection || connection.status !== 'active' || !(await isConnectionManaged(prisma, connection))) {
    return 'not_publishable';
  }

  const claimed = await prisma.gbpPost.updateMany({
    where: { id: post.id, status: 'drafted' },
    data: { status: 'publishing' },
  });
  if (claimed.count === 0) return 'not_publishable';

  const res = await publishLocalPost(connection, post.summary);
  if (res.ok) {
    await prisma.gbpPost.update({
      where: { id: post.id },
      data: { status: 'published', publishedAt: now, publishedBy: by, googlePostName: res.name, lastError: null },
    });
    return 'published';
  }
  logError('gbp_managed.publish_failed', new Error(res.error), { postId: post.id, connectionId: connection.id });
  await prisma.gbpPost.update({ where: { id: post.id }, data: { status: 'publish_failed', lastError: res.error } });
  return 'publish_failed';
}

/** El cliente edita el texto. No lo publica; quita la retención por riesgo si
 *  el texto nuevo ya no la dispara (lo ha mirado una persona). */
export async function editDraft(
  prisma: PrismaClient,
  input: { postId: string; clientId: string; summary: string },
): Promise<'ok' | 'not_found' | 'risky'> {
  const risk = findReplyRisk(input.summary);
  const updated = await prisma.gbpPost.updateMany({
    where: { id: input.postId, clientId: input.clientId, status: 'drafted' },
    data: { summary: input.summary, editedAt: new Date(), lastError: risk ? `held:${risk}` : null },
  });
  if (updated.count === 0) return 'not_found';
  return risk ? 'risky' : 'ok';
}

export async function rejectDraft(prisma: PrismaClient, input: { postId: string; clientId: string }): Promise<boolean> {
  const updated = await prisma.gbpPost.updateMany({
    where: { id: input.postId, clientId: input.clientId, status: 'drafted' },
    data: { status: 'rejected' },
  });
  return updated.count > 0;
}

export type GbpManagedCheckoutResult =
  | CreateCheckoutSessionResult
  | { ok: false; error: 'not_on_sale' | 'connection_not_found' | 'already_managed' };

/**
 * Abre el pago de la Ficha gestionada. Con connectionId (el cliente eligió la
 * ficha), la contratación pendiente se ata ya a esa ficha; sin él, se atará a
 * la primera libre cuando el cliente conecte una (linkUnlinkedManagedContracts).
 */
export async function createGbpManagedCheckout(
  prisma: PrismaClient,
  params: { clientId: string; connectionId: string | null; billing: BillingInterval; actorId: string; returnPath: string },
): Promise<GbpManagedCheckoutResult> {
  const product = await prisma.product.findFirst({
    where: { code: GBP_MANAGED_CODE, kind: 'addon', isActive: true },
    select: { id: true, stripeRecurringPriceId: true },
  });
  if (!product?.stripeRecurringPriceId) return { ok: false, error: 'not_on_sale' };

  let connection: GoogleBusinessConnection | null = null;
  if (params.connectionId) {
    // La ficha se busca entre las del cliente de la sesión: un id ajeno no
    // encuentra nada.
    connection = await prisma.googleBusinessConnection.findFirst({
      where: { id: params.connectionId, clientId: params.clientId, status: 'active' },
    });
    if (!connection) return { ok: false, error: 'connection_not_found' };
    if (await isConnectionManaged(prisma, connection)) return { ok: false, error: 'already_managed' };
  }

  const result = await createProductCheckoutSession({
    clientId: params.clientId,
    productId: product.id,
    actorId: params.actorId,
    billing: params.billing,
    returnPath: params.returnPath,
  });
  if (result.ok && connection && result.clientProductId) {
    // El checkout puede reaprovechar una contratación cancelada que seguía
    // atada a otra ficha: se suelta allí antes de atarla aquí (el enlace es
    // único).
    await prisma.googleBusinessConnection.updateMany({
      where: { managedClientProductId: result.clientProductId, id: { not: connection.id } },
      data: { managedClientProductId: null },
    });
    await prisma.googleBusinessConnection.update({
      where: { id: connection.id },
      data: { managedClientProductId: result.clientProductId },
    });
  }
  return result;
}

export interface GbpManagedView {
  /** Null si no está a la venta (aún no creada en Stripe). */
  offer: { priceCents: number; annualPriceCents: number | null; currency: string } | null;
  managed: boolean;
  /** El borrador de la semana, si hay uno pendiente. */
  draft: { id: string; summary: string; publishAfter: string; held: boolean } | null;
  lastPublished: { summary: string; publishedAt: string } | null;
  lastFailed: { error: string | null } | null;
}

/** Lo que la tarjeta de /portal/resenas (o /portal/seo, sin ficha) necesita. */
export async function getGbpManagedView(
  prisma: PrismaClient,
  clientId: string,
  connection: Pick<GoogleBusinessConnection, 'id' | 'managedClientProductId'> | null,
): Promise<GbpManagedView> {
  const product = await prisma.product.findFirst({
    where: { code: GBP_MANAGED_CODE, kind: 'addon', isActive: true },
    select: { priceCents: true, currency: true, stripeRecurringPriceId: true, stripeAnnualPriceId: true },
  });
  const offer = product?.stripeRecurringPriceId
    ? {
        priceCents: product.priceCents,
        annualPriceCents: product.stripeAnnualPriceId ? annualPriceCents(product.priceCents) : null,
        currency: product.currency,
      }
    : null;

  if (!connection) {
    // Sin ficha: gestionado si tiene alguna contratación activa esperando ficha.
    const pending = await prisma.clientProduct.findFirst({
      where: { clientId, status: 'active', product: { code: GBP_MANAGED_CODE } },
      select: { id: true },
    });
    return { offer, managed: pending !== null, draft: null, lastPublished: null, lastFailed: null };
  }

  const managed = await isConnectionManaged(prisma, connection);
  if (!managed) return { offer, managed, draft: null, lastPublished: null, lastFailed: null };

  const [draft, published, failed] = await Promise.all([
    prisma.gbpPost.findFirst({
      where: { connectionId: connection.id, status: 'drafted' },
      orderBy: { generatedAt: 'desc' },
      select: { id: true, summary: true, publishAfter: true, lastError: true },
    }),
    prisma.gbpPost.findFirst({
      where: { connectionId: connection.id, status: 'published' },
      orderBy: { publishedAt: 'desc' },
      select: { summary: true, publishedAt: true },
    }),
    prisma.gbpPost.findFirst({
      where: { connectionId: connection.id, status: 'publish_failed' },
      orderBy: { updatedAt: 'desc' },
      select: { lastError: true, updatedAt: true },
    }),
  ]);
  return {
    offer,
    managed,
    draft: draft
      ? {
          id: draft.id,
          summary: draft.summary,
          publishAfter: draft.publishAfter.toISOString(),
          held: Boolean(draft.lastError?.startsWith('held:')),
        }
      : null,
    lastPublished: published?.publishedAt
      ? { summary: published.summary, publishedAt: published.publishedAt.toISOString() }
      : null,
    lastFailed:
      failed && (!published?.publishedAt || failed.updatedAt > published.publishedAt)
        ? { error: failed.lastError }
        : null,
  };
}
