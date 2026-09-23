import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { generateWebDraftCopy, type WebDraftCopy } from '@/lib/web-draft-ai';
import { renderWebDraftHtml, themeFor } from '@/lib/web-draft-html';
import { createShareToken, webDraftShareUrl } from '@/lib/prospecting-share';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// A11, capa 1 · GET /api/admin/portal/prospecting/web-draft/[leadId]
//
// Devuelve el borrador de web de un prospecto como página completa, lista
// para enseñar en la llamada o mandar por WhatsApp. Es el complemento del
// informe comparativo: el informe dice qué le falta, el borrador enseña cómo
// quedaría resuelto.
//
// Ruta de OPERADOR y bajo demanda, por lo mismo que el informe: generar
// cuesta dinero (una llamada a Sonnet por borrador) y el cupo de la campaña
// no cubre ese gasto. La capa 2 lo hará automático en el barrido, con su
// propio tope diario; la capa 3 lo abrirá al público, y eso exige antes
// límite por IP y verificación.
//
// El borrador se GUARDA y se reutiliza: el texto lo escribe un modelo y dos
// generaciones seguidas no dan lo mismo. El comercial enseña una página por
// teléfono y el prospecto abre el enlace media hora después — tienen que ver
// lo mismo. ?regenerar=1 fuerza una nueva.
// =============================================================================

export async function GET(req: NextRequest, ctx: { params: { leadId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const lead = await prisma.lead.findUnique({
    where: { id: ctx.params.leadId },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      contactName: true,
      contactPhone: true,
      summary: true,
      primaryType: true,
      searchCategory: true,
      searchLocation: true,
      webDraft: true,
      competitorSnapshot: { select: { subjectRating: true, subjectReviewCount: true } },
    },
  });
  if (!lead) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const businessName = lead.contactName?.trim();
  if (!businessName) {
    // Sin nombre no hay web que enseñar, y ponerle uno inventado al negocio
    // es la peor forma posible de empezar una llamada.
    return NextResponse.json({ error: 'lead_without_name' }, { status: 422 });
  }

  const subject = {
    businessName,
    primaryType: lead.primaryType,
    city: lead.searchLocation,
    address: lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
    phone: lead.contactPhone,
    // Las estrellas salen del snapshot del informe comparativo si ya existe.
    // No se pide a Google aquí: quien abre el borrador casi siempre viene de
    // haber abierto antes el informe, y una llamada de pago de más por una
    // línea decorativa no se justifica.
    rating: lead.competitorSnapshot?.subjectRating ?? null,
    reviewCount: lead.competitorSnapshot?.subjectReviewCount ?? null,
  };

  const url = new URL(req.url);
  const regenerate = url.searchParams.get('regenerar') === '1';

  let shareToken: string | null = lead.webDraft?.shareToken ?? null;
  let copy: WebDraftCopy | null =
    !regenerate && lead.webDraft ? (lead.webDraft.copy as unknown as WebDraftCopy) : null;
  let generatedAt = lead.webDraft?.generatedAt ?? new Date();

  if (!copy) {
    const result = await generateWebDraftCopy({
      businessName,
      primaryType: lead.primaryType,
      category: lead.searchCategory,
      city: lead.searchLocation,
      address: subject.address,
      phone: lead.contactPhone,
      rating: subject.rating,
      reviewCount: subject.reviewCount,
    });

    if ('skipped' in result) {
      return NextResponse.json({ error: 'no_api_key' }, { status: 503 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    copy = result.copy;
    generatedAt = new Date();
    const payload = {
      clientId: lead.clientId,
      tenantId: lead.tenantId,
      copy: copy as unknown as object,
      themeKey: themeFor(lead.primaryType).key,
      model: result.model,
      generatedAt,
    };
    try {
      // El testigo se crea UNA vez y no cambia al regenerar: un enlace que ya
      // mandaste por WhatsApp tiene que seguir abriendo aunque después
      // reescribas el texto.
      const saved = await prisma.prospectingWebDraft.upsert({
        where: { leadId: lead.id },
        create: { leadId: lead.id, ...payload, shareToken: createShareToken() },
        update: payload,
        select: { shareToken: true },
      });
      shareToken = saved.shareToken;
    } catch (err) {
      // La generación ya está pagada: que no se pueda guardar no debe
      // impedir que el comercial vea el borrador que acaba de pedir.
      logError('web_draft.persist_failed', err, { leadId: lead.id }, 'warn');
    }
  }

  // El operador ve además el enlace público que puede copiar y mandar: sin
  // esto tendría que construirlo a mano, y el enlace de esta misma ruta NO
  // sirve — pedirá sesión al prospecto.
  const shareUrl = shareToken ? webDraftShareUrl(new URL(req.url).origin, shareToken) : null;

  return new NextResponse(
    renderWebDraftHtml({ subject, copy, generatedAt, shareUrl, themeKey: lead.webDraft?.themeKey ?? null }),
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    },
  );
}
