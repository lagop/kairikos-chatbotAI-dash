import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { InMemoryRateLimiter } from './operator-crypto';
import { isProductContracted } from './client-product-access';
import {
  buildReviewFeed,
  generateReviewFeedToken,
  hashReviewFeedToken,
  isReviewFeedTokenShape,
  reviewFeedUrl,
  type ReviewFeed,
} from './review-feed-rules';

// =============================================================================
// Reseñas en la web Premium (23/11/2026) — el feed por token que lee la build
// de la web del cliente. Las reglas viven en review-feed-rules.ts.
//
// Decisión del propietario: la web se reconstruye SOLA cada noche (publicar.yml
// de su repositorio, con `schedule:`), no cuando el portal se lo pide. Así el
// portal no guarda repositorios ni lanza nada: solo sirve el feed y apunta
// cuándo lo leyó la web por última vez, que es lo que enseña el panel.
//
// Un token por ficha de Google (GoogleBusinessConnection): una web es un
// negocio, y un cliente con dos locales tiene dos webs o una web con una
// sola ficha. Lo emite el operador desde la ficha del cliente; solo se guarda
// su hash y el token en claro se enseña una vez, para el secreto
// REVIEWS_FEED_URL del repositorio de la web (nunca en su HTML).
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

export const REVIEWS_PRODUCT_CODE = 'reviews';

// Por token y no por IP: el runner de GitHub cambia de IP en cada build. Una
// build lo pide una vez; el límite solo frena un bucle o un token filtrado.
const feedLimiter = new InMemoryRateLimiter(60 * 1000);
export const REVIEW_FEED_READS_PER_MINUTE = 30;

export function allowReviewFeedRead(token: string): boolean {
  return feedLimiter.check(`review-feed:${token}`, REVIEW_FEED_READS_PER_MINUTE);
}

export type ReviewFeedLookup =
  | { ok: true; feed: ReviewFeed; connectionId: string }
  | { ok: false; error: 'not_found' }
  /** La ficha existe, pero Reseñas ya no está contratado o la ficha se desconectó:
   *  la web debe publicarse SIN reseñas, no quedarse con las de antes. */
  | { ok: false; error: 'gone' };

/** El feed de una ficha por su token. Apunta la lectura. */
export async function readReviewFeed(db: Db, token: string, now: Date = new Date()): Promise<ReviewFeedLookup> {
  if (!isReviewFeedTokenShape(token)) return { ok: false, error: 'not_found' };
  const connection = await db.googleBusinessConnection.findUnique({
    where: { websiteFeedTokenHash: hashReviewFeedToken(token) },
    select: { id: true, clientId: true, status: true, lastSyncAt: true, reviewUrl: true },
  });
  if (!connection) return { ok: false, error: 'not_found' };
  if (connection.status === 'revoked' || !(await isProductContracted(db as PrismaClient, connection.clientId, REVIEWS_PRODUCT_CODE))) {
    return { ok: false, error: 'gone' };
  }

  // Una ficha que pide reconectar (needs_reconnect) sigue sirviendo lo último
  // sincronizado: son reseñas reales, solo menos recientes.
  const rows = await db.googleReview.findMany({
    where: { connectionId: connection.id, removedAt: null },
    orderBy: { createTime: 'desc' },
    select: {
      googleReviewId: true,
      reviewerName: true,
      starRating: true,
      comment: true,
      createTime: true,
      updateTime: true,
      replyComment: true,
      replyUpdatedAt: true,
      removedAt: true,
    },
  });
  const feed = buildReviewFeed(rows, { syncedAt: connection.lastSyncAt, writeUrl: connection.reviewUrl });
  await db.googleBusinessConnection.update({ where: { id: connection.id }, data: { websiteFeedReadAt: now } });
  return { ok: true, feed, connectionId: connection.id };
}

export type IssueResult = { ok: true; feedUrl: string } | { ok: false; error: 'not_found' };

/**
 * Emite (o sustituye) el token del feed de una ficha. El anterior deja de
 * valer en el acto: la web que lo usaba falla su próxima build hasta que se
 * cambie el secreto, y sigue con la versión que tenía.
 */
export async function issueReviewFeedToken(
  db: Db,
  input: { connectionId: string; clientId?: string; baseUrl: string },
): Promise<IssueResult> {
  const connection = await db.googleBusinessConnection.findFirst({
    where: { id: input.connectionId, ...(input.clientId ? { clientId: input.clientId } : {}) },
    select: { id: true },
  });
  if (!connection) return { ok: false, error: 'not_found' };
  const token = generateReviewFeedToken();
  await db.googleBusinessConnection.update({
    where: { id: connection.id },
    data: { websiteFeedTokenHash: hashReviewFeedToken(token), websiteFeedReadAt: null },
  });
  return { ok: true, feedUrl: reviewFeedUrl(input.baseUrl, token) };
}

/** Retira el feed: ninguna web puede leerlo. La web se queda con lo último publicado
 *  hasta que se le quite el secreto (sin él, publica sin reseñas). */
export async function revokeReviewFeedToken(db: Db, input: { connectionId: string; clientId?: string }): Promise<{ ok: boolean }> {
  const r = await db.googleBusinessConnection.updateMany({
    where: { id: input.connectionId, ...(input.clientId ? { clientId: input.clientId } : {}) },
    data: { websiteFeedTokenHash: null, websiteFeedReadAt: null },
  });
  return { ok: r.count > 0 };
}
