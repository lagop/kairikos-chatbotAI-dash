import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { approveDraft, AUTO_APPROVE_REVIEWED_BY } from './seo-content-review';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase 5 — "publicar salvo veto pasados unos días".
//
// El informe lo describía con dos mecanismos: una ventana de tiempo, o
// "en cuanto un cliente acumule varios borradores aceptados sin
// cambios". Solo se construye el primero. El segundo necesitaría una
// señal que hoy no existe en ningún sitio: nada distingue "el operador
// aprobó tal cual" de "el operador aprobó después de editar" — la ruta
// de revisión es aprobar/rechazar, no editar, así que "aceptado sin
// cambios" no es un dato que se pueda leer, es uno que habría que
// inventarse. Construir un contador de confianza sobre una señal que no
// existe sería aparentar más automatización de la que hay.
//
// El único veto es el mismo de siempre: rechazar (`action: 'reject'`) o
// aprobar a mano ANTES de que pase la ventana. En cuanto cualquiera de
// las dos ocurre, el borrador deja de estar en 'drafted' y este barrido
// deja de verlo — sin mecanismo nuevo, igual que en el wizard de
// chatbot (src/lib/wizard-auto-approve.ts).
//
// A diferencia de los tres pasos del wizard marcados de bajo riesgo, aquí
// NO hay una separación por riesgo que hacer: solo existe una puerta de
// aprobación (no doce), y el propio informe la señaló entera como
// automatizable. Vale la pena decirlo con la misma honestidad que el
// resto de esta sesión: un artículo de SEO es contenido público, firmado
// con la marca del cliente, publicado de forma permanente — un riesgo de
// naturaleza distinta al de que el bot cite mal un horario. La ventana
// de veto es la salvaguarda, no un adorno: se eligió corta a propósito
// (ver SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS) para que la revisión siga
// siendo el camino normal y esto solo cubra al operador que se retrasa.
// =============================================================================

/** Días desde que el borrador se generó (no desde que se pidió — un
 *  cliente puede tener varias solicitudes en cola) hasta que se aprueba
 *  solo si nadie lo ha tocado. Tres días: suficiente para una revisión
 *  real de contenido dentro de una semana laboral, corto para que un
 *  backlog no se acumule sin publicarse durante semanas. */
export const SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pura, misma forma que isAuditDue/isGenerationDue. `null` (un borrador
 *  'drafted' sin generatedAt no debería darse en la práctica — solo las
 *  filas antiguas en 'pending_generation' carecen de él, y esas nunca
 *  entran en la query de este barrido) nunca está vencido: sin fecha
 *  desde la que contar, aprobar solo sería inventarse el plazo. */
export function isDraftPastVetoWindow(
  generatedAt: Date | null,
  now: Date,
  windowDays: number = SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS,
): boolean {
  if (!generatedAt) return false;
  return now.getTime() - generatedAt.getTime() >= windowDays * DAY_MS;
}

/**
 * Cuándo se auto-aprobará este borrador, si es que se va a auto-aprobar.
 * `null` cubre "nunca" (ya no está `drafted`) y "no aplica todavía" (sin
 * `generatedAt`). Pura — la pantalla del operador la usa para mostrar la
 * cuenta atrás sin repetir la aritmética ni importar este módulo
 * `server-only` desde un componente de cliente.
 */
export function computeAutoApproveDeadline(params: {
  status: string;
  generatedAt: Date | null;
  windowDays?: number;
}): Date | null {
  if (params.status !== 'drafted' || !params.generatedAt) return null;
  const windowDays = params.windowDays ?? SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS;
  return new Date(params.generatedAt.getTime() + windowDays * DAY_MS);
}

/** Techo de aprobaciones (con su intento de publicación) por tick. Cada
 *  una es una llamada REST a WordPress, no un LLM — más rápida que
 *  generar, pero de red igualmente, y capada por el mismo motivo que
 *  MAX_GENERATIONS_PER_TICK: lo que no entra en este tick sigue vencido
 *  y entra en el siguiente, cinco minutos después. */
const MAX_AUTO_APPROVALS_PER_TICK = 3;

export interface SeoDraftAutoApproveFailure {
  draftId: string;
  clientId: string;
  error: string;
}

export interface SeoDraftAutoApproveSweepResult {
  /** Borradores 'drafted' más allá de la ventana, antes de procesar. */
  due: number;
  /** De ésos, los que de verdad se intentaron en este tick (ver
   *  MAX_AUTO_APPROVALS_PER_TICK). */
  processed: number;
  /** Fase 6 — approveDraft ya no publica: aprobar solo mueve el
   *  borrador a 'pending_client_review'. El resultado de publicar (o
   *  no) es cosa de la segunda ventana, ver seo-draft-auto-publish.ts. */
  approved: number;
  failed: SeoDraftAutoApproveFailure[];
}

const EMPTY_RESULT: SeoDraftAutoApproveSweepResult = {
  due: 0,
  processed: 0,
  approved: 0,
  failed: [],
};

/**
 * El cron entry point (/api/cron/seo-draft-auto-approve). Nunca lanza:
 * aislado por borrador, mismo criterio que el resto de los `sweep*` de
 * esta sesión — un fallo puntual (WordPress caído, credenciales
 * revocadas) no puede tumbar el resto del barrido.
 *
 * Seguro de llamar más veces de las que hace falta: la elegibilidad se
 * recalcula contra `generatedAt` en cada llamada, nunca contra la
 * cadencia del scheduler.
 */
export async function sweepAutoApprovableSeoDrafts(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<SeoDraftAutoApproveSweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS * DAY_MS);

  let candidates: { id: string; clientId: string }[];
  try {
    candidates = await prisma.seoContentDraft.findMany({
      where: { status: 'drafted', generatedAt: { lte: cutoff } },
      orderBy: { generatedAt: 'asc' },
      select: { id: true, clientId: true },
    });
  } catch (err) {
    logError('seo_draft_auto_approve.scan_failed', err, {}, 'warn');
    return { ...EMPTY_RESULT, failed: [{ draftId: 'n/a', clientId: 'n/a', error: err instanceof Error ? err.message : 'unknown error' }] };
  }

  const batch = candidates.slice(0, MAX_AUTO_APPROVALS_PER_TICK);
  const result: SeoDraftAutoApproveSweepResult = {
    ...EMPTY_RESULT,
    due: candidates.length,
    processed: batch.length,
    failed: [],
  };

  for (const draft of batch) {
    try {
      await approveDraft(prisma, {
        draftId: draft.id,
        clientId: draft.clientId,
        reviewedBy: AUTO_APPROVE_REVIEWED_BY,
      });
      result.approved += 1;
    } catch (err) {
      logError('seo_draft_auto_approve.draft_failed', err, { clientId: draft.clientId, draftId: draft.id }, 'warn');
      result.failed.push({
        draftId: draft.id,
        clientId: draft.clientId,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return result;
}
