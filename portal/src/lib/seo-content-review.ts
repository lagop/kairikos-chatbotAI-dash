import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { publishDraftToWordPress, hasWordPressCredentials } from './wordpress-publish';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase C/5/6 — la escritura compartida de las dos puertas de
// revisión de un borrador.
//
// Fase 6 añade una SEGUNDA puerta: aprobar ya no publica de inmediato.
// El operador aprueba (catches hallucinations/misalignment ANTES de que
// el cliente vea nada) y el borrador pasa a 'pending_client_review' —
// visible dentro del propio portal del cliente, no todavía en su
// WordPress real. Solo cuando el CLIENTE aprueba (o se queda callado
// pasada su propia ventana, ver seo-draft-auto-publish.ts) se llama de
// verdad a la API de WordPress. Dos aprobadores, dos ventanas de veto
// independientes — el operador ya no es quien decide que algo sale en
// vivo en el sitio del cliente, solo que no es basura.
//
// Extraído de la ruta del operador (content-drafts/[draftId]/route.ts)
// cuando apareció un SEGUNDO llamante que hace lo mismo: el barrido de
// aprobación automática (seo-draft-auto-approve.ts, Fase 5). Antes de
// esto vivía entero dentro del handler PATCH porque solo el operador lo
// llamaba.
//
// `reviewedBy`/`clientReviewedBy` son cadenas libres, no una FK — a
// diferencia del wizard de chatbot (ChatbotConfigStep.approvedByOperatorId,
// una FK real a Operator), aquí no hay ninguna columna que una
// aprobación automática tenga que dejar en NULL para no inventarse un
// operador. Un valor como 'system:auto_approve' es una fila
// perfectamente válida — mismo criterio para 'client:<clientId>'
// (convención ya establecida en el resto del repo) y
// 'system:auto_publish_client_timeout'.
// =============================================================================

/** Quien la ve en el panel del operador (SeoContentDraftsPanel) sabe que
 *  no la aprobó una persona. Exportado para que el barrido y sus tests
 *  compartan el mismo valor en vez de que cada uno lo escriba a mano. */
export const AUTO_APPROVE_REVIEWED_BY = 'system:auto_approve';

/** El equivalente para la segunda puerta: el cliente no reaccionó
 *  dentro de su propia ventana. Ver seo-draft-auto-publish.ts. */
export const AUTO_PUBLISH_REVIEWED_BY = 'system:auto_publish_client_timeout';

export type AttemptPublishResult = { ok: true } | { ok: false; error: string };

/**
 * Intenta publicar un borrador ya aprobado en WordPress. Nunca lanza:
 * cualquier fallo dvuelve `{ok:false}` y deja el borrador en
 * 'publish_failed' con el motivo, para que retry_publish pueda
 * reintentarlo sin tener que volver a aprobarlo.
 */
export async function attemptPublishDraft(
  prisma: PrismaClient,
  draftId: string,
  clientId: string,
): Promise<AttemptPublishResult> {
  const draft = await prisma.seoContentDraft.findUnique({
    where: { id: draftId },
    select: { id: true, profileId: true, title: true, bodyHtml: true, metaDescription: true },
  });
  if (!draft || !draft.title || !draft.bodyHtml) {
    return { ok: false, error: 'draft_incomplete' };
  }

  const profile = await prisma.seoProfile.findUnique({
    where: { id: draft.profileId },
    select: {
      wordpressUrl: true,
      wordpressUsername: true,
      wordpressAppPasswordCiphertext: true,
      wordpressAppPasswordIv: true,
      wordpressAppPasswordTag: true,
    },
  });

  if (!hasWordPressCredentials(profile)) {
    await prisma.seoContentDraft.update({
      where: { id: draftId },
      data: { status: 'publish_failed', publishError: 'missing_wordpress_credentials' },
    });
    return { ok: false, error: 'missing_wordpress_credentials' };
  }

  const result = await publishDraftToWordPress(profile, {
    title: draft.title,
    bodyHtml: draft.bodyHtml,
    metaDescription: draft.metaDescription,
  });

  if (result.ok) {
    await prisma.seoContentDraft.update({
      where: { id: draftId },
      data: {
        status: 'published',
        publishedAt: new Date(),
        wordpressPostId: result.postId,
        wordpressPostUrl: result.postUrl,
        publishError: null,
      },
    });
    return { ok: true };
  }

  logError('seo_content_review.publish_failed', new Error(result.error), { clientId, draftId }, 'warn');
  await prisma.seoContentDraft.update({
    where: { id: draftId },
    data: { status: 'publish_failed', publishError: result.error.slice(0, 500) },
  });
  return { ok: false, error: result.error };
}

export interface ApproveDraftResult {
  status: 'pending_client_review';
}

/**
 * Marca un borrador 'pending_client_review' — el operador ya lo revisó,
 * pero YA NO publica en este paso (Fase 6): el segundo aprobador es el
 * cliente, no esta función. `reviewedBy` es quién decidió: el email de
 * un operador, o AUTO_APPROVE_REVIEWED_BY.
 *
 * No comprueba `status === 'drafted'` — eso es responsabilidad del
 * llamante (la ruta ya lo hacía antes de esta extracción; el barrido lo
 * hace en su propia query), porque el mensaje de error correcto en cada
 * caso es distinto (409 en la ruta, un simple "sáltate esta fila" en el
 * barrido).
 */
export async function approveDraft(
  prisma: PrismaClient,
  params: { draftId: string; clientId: string; reviewedBy: string },
): Promise<ApproveDraftResult> {
  await prisma.seoContentDraft.update({
    where: { id: params.draftId },
    data: {
      status: 'pending_client_review',
      reviewedBy: params.reviewedBy,
      reviewedAt: new Date(),
      rejectionReason: null,
      clientReviewRequestedAt: new Date(),
    },
  });
  return { status: 'pending_client_review' };
}

export interface PublishAfterClientReviewResult {
  status: 'published' | 'publish_failed';
  publishError?: string;
}

/**
 * El segundo "aprobar" — esta vez del cliente, o del barrido cuando el
 * cliente se queda callado pasada su ventana (AUTO_PUBLISH_REVIEWED_BY).
 * Deja constancia de quién decidió ANTES de intentar publicar, para que
 * quede registrado incluso si la llamada a WordPress falla.
 */
export async function publishAfterClientReview(
  prisma: PrismaClient,
  params: { draftId: string; clientId: string; clientReviewedBy: string },
): Promise<PublishAfterClientReviewResult> {
  await prisma.seoContentDraft.update({
    where: { id: params.draftId },
    data: { clientReviewedBy: params.clientReviewedBy, clientReviewedAt: new Date() },
  });
  const publishResult = await attemptPublishDraft(prisma, params.draftId, params.clientId);
  return {
    status: publishResult.ok ? 'published' : 'publish_failed',
    publishError: publishResult.ok ? undefined : publishResult.error,
  };
}

/**
 * El cliente pide cambios en vez de aprobar. A diferencia del rechazo
 * del operador (que sale de 'drafted'), este sale de
 * 'pending_client_review' — mismo status final ('rejected'), pero deja
 * su propio rastro en clientReviewedBy/clientReviewedAt en vez de
 * pisar reviewedBy/reviewedAt del operador, que sigue reflejando quién
 * lo aprobó a él en primer lugar.
 */
export async function rejectDraftByClient(
  prisma: PrismaClient,
  params: { draftId: string; clientId: string; rejectionReason: string },
): Promise<void> {
  await prisma.seoContentDraft.update({
    where: { id: params.draftId },
    data: {
      status: 'rejected',
      clientReviewedBy: `client:${params.clientId}`,
      clientReviewedAt: new Date(),
      rejectionReason: params.rejectionReason,
    },
  });
}
