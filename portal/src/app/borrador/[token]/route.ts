import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { renderWebDraftHtml } from '@/lib/web-draft-html';
import type { WebDraftCopy } from '@/lib/web-draft-ai';
import { logError } from '@/lib/observability';

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
 * Solo LEE lo que el operador ya generó. No llama a Anthropic ni a Google
 * por mucho que se recargue: sin borrador guardado, 404. Esa es la línea que
 * hace que un enlace público no pueda costar dinero.
 *
 * Nada aquí depende del token para nada más que encontrar la fila: no hay
 * sesión que suplantar ni datos de otro cliente que alcanzar.
 */
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
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
        generatedAt: true,
        lead: {
          select: {
            contactName: true,
            contactPhone: true,
            summary: true,
            primaryType: true,
            searchLocation: true,
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

    const html = renderWebDraftHtml({
      subject: {
        businessName: draft.lead.contactName,
        primaryType: draft.lead.primaryType,
        city: draft.lead.searchLocation,
        address: draft.lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
        phone: draft.lead.contactPhone,
        rating: draft.lead.competitorSnapshot?.subjectRating ?? null,
        reviewCount: draft.lead.competitorSnapshot?.subjectReviewCount ?? null,
      },
      copy: draft.copy as unknown as WebDraftCopy,
      generatedAt: draft.generatedAt,
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
