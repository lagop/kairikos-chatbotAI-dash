import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { publishDraftToWordPress, hasWordPressCredentials } from './wordpress-publish';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase C/5 — la escritura compartida de aprobar un borrador.
//
// Extraído de la ruta del operador (content-drafts/[draftId]/route.ts)
// cuando apareció un SEGUNDO llamante que hace lo mismo: el barrido de
// aprobación automática (seo-draft-auto-approve.ts, Fase 5). Antes de
// esto vivía entero dentro del handler PATCH porque solo el operador lo
// llamaba.
//
// `reviewedBy` es una cadena libre, no una FK — a diferencia del wizard
// de chatbot (ChatbotConfigStep.approvedByOperatorId, una FK real a
// Operator), aquí no hay ninguna columna que una aprobación automática
// tenga que dejar en NULL para no inventarse un operador. Un valor como
// 'system:auto_approve' es una fila perfectamente válida.
// =============================================================================

/** Quien la ve en el panel del operador (SeoContentDraftsPanel) sabe que
 *  no la aprobó una persona. Exportado para que el barrido y sus tests
 *  compartan el mismo valor en vez de que cada uno lo escriba a mano. */
export const AUTO_APPROVE_REVIEWED_BY = 'system:auto_approve';

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
  status: 'published' | 'publish_failed';
  publishError?: string;
}

/**
 * Marca un borrador 'approved' y de inmediato intenta publicarlo — el
 * mismo par de pasos que hacía la ruta PATCH inline. `reviewedBy` es
 * quién decidió: el email de un operador, o AUTO_APPROVE_REVIEWED_BY.
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
    data: { status: 'approved', reviewedBy: params.reviewedBy, reviewedAt: new Date(), rejectionReason: null },
  });
  const publishResult = await attemptPublishDraft(prisma, params.draftId, params.clientId);
  return {
    status: publishResult.ok ? 'published' : 'publish_failed',
    publishError: publishResult.ok ? undefined : publishResult.error,
  };
}
