import { NextResponse, type NextRequest } from 'next/server';
import type { PublicDraftRequest } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { renderPublicDraft } from '@/lib/public-draft-page';
import { deliveryDueAt, renderPreparingPage } from '@/lib/public-draft-delivery';
import { logError } from '@/lib/observability';
import { getWebDraftPurchase, purchaseCtaFor } from '@/lib/web-self-serve';
import { KAIRIKOS_DEMO_URL } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A11, capa 3 — GET /mi-web/[token]
 *
 * El borrador que pidió un negocio desde kairikos.com. Pública, con testigo,
 * igual que /borrador/[token] de prospección: la diferencia es solo quién lo
 * pidió (él mismo, en vez de nosotros por teléfono).
 *
 * Solo LEE lo ya generado. Recargar no vuelve a llamar al modelo, así que un
 * enlace compartido no cuesta dinero por mucho que corra.
 *
 * 30/10/2026 — hasta que se le envía (lib/public-draft-delivery.ts) enseña
 * «la estamos preparando» con el plazo, aunque el borrador ya esté escrito: es
 * el rato que tiene el operador para revisarlo.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  if (!isShareToken(params.token)) {
    return new NextResponse('Enlace no válido.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (!isDatabaseConfigured) {
    return new NextResponse('No disponible.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  try {
    const request = await prisma.publicDraftRequest.findUnique({ where: { token: params.token } });
    if (!request) {
      return new NextResponse('Este enlace ya no está disponible.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const html = request.sentAt && request.copy
      ? await renderSent(request, params.token)
      : renderPreparingPage({ businessName: request.businessName, dueAt: deliveryDueAt(request.createdAt) });

    return new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch (err) {
    logError('public_draft.view_failed', err, { route: 'app/mi-web/[token]' }, 'warn');
    return new NextResponse('No hemos podido mostrar esta página.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function renderSent(request: PublicDraftRequest, token: string) {
  // 25/10/2026 — «La quiero»: comprarla sin llamada (lib/web-self-serve.ts).
  // Si mirarlo falla, el borrador se enseña igual, sin el botón.
  const purchase = await getWebDraftPurchase(prisma, token, new Date()).catch(() => null);
  const { cta, offer } = purchaseCtaFor(purchase, token, KAIRIKOS_DEMO_URL);
  const html = await renderPublicDraft(prisma, request, { purchase: cta, offer });
  if (!html) throw new Error('public_draft_without_copy');
  return html;
}
