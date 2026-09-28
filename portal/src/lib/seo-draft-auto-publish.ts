import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { publishAfterClientReview, AUTO_PUBLISH_REVIEWED_BY } from './seo-content-review';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase 6 — la segunda ventana de "publicar salvo veto",
// esta vez del lado del cliente. Mismo criterio y misma forma exacta
// que seo-draft-auto-approve.ts (Fase 5) — no se repite aquí el
// razonamiento completo de por qué solo se construye un mecanismo de
// ventana de tiempo y no un contador de confianza; ver ese archivo.
//
// El único veto es el mismo de siempre: el cliente aprueba o pide
// cambios ANTES de que pase la ventana, desde /portal/seo. En cuanto
// cualquiera de las dos ocurre, el borrador deja de estar en
// 'pending_client_review' y este barrido deja de verlo.
// =============================================================================

/** Días desde que el operador aprobó (clientReviewRequestedAt) hasta
 *  que se publica sola si el cliente no ha reaccionado. Misma duración
 *  que la ventana del operador — decisión explícita del usuario, no
 *  hay motivo para que la paciencia con el cliente sea distinta de la
 *  paciencia con el propio equipo. */
export const SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pura, misma forma que isDraftPastVetoWindow. */
export function isDraftPastClientReviewWindow(
  clientReviewRequestedAt: Date | null,
  now: Date,
  windowDays: number = SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS,
): boolean {
  if (!clientReviewRequestedAt) return false;
  return now.getTime() - clientReviewRequestedAt.getTime() >= windowDays * DAY_MS;
}

/**
 * Cuándo se publicará este borrador solo, si es que va a publicarse
 * solo. `null` cubre "nunca" (ya no está pending_client_review) y "no
 * aplica todavía" (sin clientReviewRequestedAt). Pura — tanto la
 * pantalla del cliente como la del operador la usan para mostrar la
 * cuenta atrás sin repetir la aritmética.
 */
export function computeAutoPublishDeadline(params: {
  status: string;
  clientReviewRequestedAt: Date | null;
  windowDays?: number;
}): Date | null {
  if (params.status !== 'pending_client_review' || !params.clientReviewRequestedAt) return null;
  const windowDays = params.windowDays ?? SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS;
  return new Date(params.clientReviewRequestedAt.getTime() + windowDays * DAY_MS);
}

/** Mismo techo por tick que el barrido del operador, mismo motivo. */
const MAX_AUTO_PUBLISHES_PER_TICK = 3;

export interface SeoDraftAutoPublishFailure {
  draftId: string;
  clientId: string;
  error: string;
}

export interface SeoDraftAutoPublishSweepResult {
  /** Borradores 'pending_client_review' más allá de la ventana, antes de procesar. */
  due: number;
  /** De ésos, los que de verdad se intentaron en este tick. */
  processed: number;
  published: number;
  publishFailed: number;
  failed: SeoDraftAutoPublishFailure[];
}

const EMPTY_RESULT: SeoDraftAutoPublishSweepResult = {
  due: 0,
  processed: 0,
  published: 0,
  publishFailed: 0,
  failed: [],
};

/**
 * El cron entry point (/api/cron/seo-draft-auto-publish). Nunca lanza:
 * aislado por borrador, mismo criterio que sweepAutoApprovableSeoDrafts.
 *
 * Seguro de llamar más veces de las que hace falta: la elegibilidad se
 * recalcula contra `clientReviewRequestedAt` en cada llamada, nunca
 * contra la cadencia del scheduler.
 */
export async function sweepAutoPublishableSeoDrafts(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<SeoDraftAutoPublishSweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS * DAY_MS);

  let candidates: { id: string; clientId: string }[];
  try {
    candidates = await prisma.seoContentDraft.findMany({
      where: { status: 'pending_client_review', clientReviewRequestedAt: { lte: cutoff } },
      orderBy: { clientReviewRequestedAt: 'asc' },
      select: { id: true, clientId: true },
    });
  } catch (err) {
    logError('seo_draft_auto_publish.scan_failed', err, {}, 'warn');
    return { ...EMPTY_RESULT, failed: [{ draftId: 'n/a', clientId: 'n/a', error: err instanceof Error ? err.message : 'unknown error' }] };
  }

  const batch = candidates.slice(0, MAX_AUTO_PUBLISHES_PER_TICK);
  const result: SeoDraftAutoPublishSweepResult = {
    ...EMPTY_RESULT,
    due: candidates.length,
    processed: batch.length,
    failed: [],
  };

  for (const draft of batch) {
    try {
      const publishResult = await publishAfterClientReview(prisma, {
        draftId: draft.id,
        clientId: draft.clientId,
        clientReviewedBy: AUTO_PUBLISH_REVIEWED_BY,
      });
      if (publishResult.status === 'published') result.published += 1;
      else if (publishResult.status === 'publish_failed') result.publishFailed += 1;
      // 'not_publishable': el cliente lo aprobó (o rechazó) entre la
      // consulta y este paso. Ya no es cosa del barrido.
    } catch (err) {
      logError('seo_draft_auto_publish.draft_failed', err, { clientId: draft.clientId, draftId: draft.id }, 'warn');
      result.failed.push({
        draftId: draft.id,
        clientId: draft.clientId,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return result;
}
