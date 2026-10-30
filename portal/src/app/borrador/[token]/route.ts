import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { renderWebDraftHtml } from '@/lib/web-draft-html';
import type { WebDraftCopy } from '@/lib/web-draft-ai';
import { renderDesignedDraft } from '@/lib/web-draft-design';
import { logError } from '@/lib/observability';
import { getWebDraftPurchase, purchaseCtaFor } from '@/lib/web-self-serve';
import { KAIRIKOS_DEMO_URL } from '@/lib/portal-data';
import { getLiveDraftData } from '@/lib/web-draft-live';
import { leadDraftSubject } from '@/lib/web-draft-subject';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A11 — GET /borrador/[token]
 *
 * El enlace que se le manda al prospecto por WhatsApp. **Público a
 * propósito**, igual que /r/[requestId] para las invitaciones a reseñar:
 * quien lo abre es el dueño de un negocio que no es cliente nuestro, no
 * tiene sesión y no va a crearse una cuenta para ver una propuesta.
 *
 * Solo LEE lo que el operador ya generó. No llama a Anthropic por mucho que
 * se recargue: sin borrador guardado, 404.
 *
 * A Google SÍ (26/10/2026): la valoración, el horario, las reseñas y la
 * dirección no se pueden guardar (condiciones de Google Maps Platform) y se
 * piden al servir la página — ver lib/web-draft-live.ts. Lo que cuesta queda
 * acotado ahí: caché de una hora por negocio y tope diario entre todos los
 * borradores. Pasado el tope, la página sale igual, sin esas secciones.
 *
 * Nada aquí depende del token para nada más que encontrar la fila: no hay
 * sesión que suplantar ni datos de otro cliente que alcanzar.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  if (!isShareToken(params.token)) {
    return new NextResponse('Enlace no válido.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (!isDatabaseConfigured) {
    return new NextResponse('No disponible.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  try {
    const draft = await prisma.prospectingWebDraft.findUnique({
      where: { shareToken: params.token },
      select: {
        copy: true,
        content: true,
        templateId: true,
        themeKey: true,
        generatedAt: true,
        lead: {
          select: {
            contactName: true,
            contactPhone: true,
            summary: true,
            primaryType: true,
            searchLocation: true,
            externalPlaceId: true,
            competitorSnapshot: { select: { subjectRating: true, subjectReviewCount: true } },
          },
        },
      },
    });

    if (!draft || !draft.lead.contactName) {
      return new NextResponse('Este enlace ya no está disponible.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // 25/10/2026 — «La quiero»: comprarla sin llamada (lib/web-self-serve.ts).
    // Solo en borradores de la prospección de Kairikos; en los de prospectos de
    // un cliente, purchaseCtaFor no devuelve nada. Si mirarlo falla, el
    // borrador se enseña igual, sin el botón.
    const purchase = await getWebDraftPurchase(prisma, params.token, new Date()).catch(() => null);
    const { cta, offer } = purchaseCtaFor(purchase, params.token, KAIRIKOS_DEMO_URL);

    const copy = draft.copy as unknown as WebDraftCopy;
    const live = await getLiveDraftData(draft.lead.externalPlaceId);
    const subject = leadDraftSubject({ ...draft.lead, contactName: draft.lead.contactName }, live, copy);

    // Webs con IA (27/10/2026): con plantilla de la biblioteca, ese diseño;
    // si no la tiene o algo falla al pintarla, el borrador de siempre.
    const designed = await renderDesignedDraft(prisma, {
      templateId: draft.templateId,
      content: draft.content,
      subject,
      themeKey: draft.themeKey,
      purchase: cta,
      offer,
    });
    const html =
      designed ??
      renderWebDraftHtml({
        purchase: cta,
        offer,
        subject,
        copy,
        generatedAt: draft.generatedAt,
        themeKey: draft.themeKey,
      });

    return new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Sin caché compartida: el enlace es de un negocio concreto y no
        // debe quedarse pegado en ningún proxy intermedio.
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch (err) {
    // Quien abre esto es un prospecto en su móvil: un 500 con traza es la
    // peor primera impresión posible. Mismo criterio que /r/[requestId].
    logError('web_draft.public_view_failed', err, { route: 'app/borrador/[token]' }, 'warn');
    return new NextResponse('No hemos podido mostrar esta página.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
