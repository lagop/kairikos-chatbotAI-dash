import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { renderWebDraftHtml } from '@/lib/web-draft-html';
import type { WebDraftCopy } from '@/lib/web-draft-ai';
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

    // 25/10/2026 — «La quiero»: comprarla sin llamada (lib/web-self-serve.ts).
    // Si mirarlo falla, el borrador se enseña igual, sin el botón.
    const purchase = await getWebDraftPurchase(prisma, params.token, new Date()).catch(() => null);
    const { cta, offer } = purchaseCtaFor(purchase, params.token, KAIRIKOS_DEMO_URL);

    const html = renderWebDraftHtml({
      purchase: cta,
      offer,
      subject: {
        businessName: request.businessName,
        primaryType: request.primaryType,
        city: request.city,
        address: null,
        // El teléfono solo se pinta si lo que dejó ES un teléfono: en la
        // portada de su propia web, un email donde debería ir el número
        // queda raro y delata que esto se ha montado solo.
        phone: /^[+0-9][0-9 ]{7,}$/.test(request.contact) ? request.contact : null,
        rating: null,
        reviewCount: null,
      },
      copy: request.copy as unknown as WebDraftCopy,
      themeKey: request.themeKey,
      generatedAt: request.createdAt,
    });

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
