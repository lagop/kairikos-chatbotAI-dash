import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { generateWebDraftCopy, type WebDraftCopy } from '@/lib/web-draft-ai';
import { renderWebDraftHtml, themeFor } from '@/lib/web-draft-html';
import { createShareToken, webDraftShareUrl } from '@/lib/prospecting-share';
import { publicOrigin } from '@/lib/public-origin';
import { logError } from '@/lib/observability';
import { getLiveDraftData } from '@/lib/web-draft-live';
import { addressFromLeadSummary, withLiveData } from '@/lib/web-draft-subject';
import { filterDraftReviews } from '@/lib/web-draft-reviews';
import { designForDraft, renderDesignedDraft } from '@/lib/web-draft-design';
import { Prisma } from '@prisma/client';

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ leadId: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const lead = await prisma.lead.findUnique({
    where: { id: (await ctx.params).leadId },
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
      externalPlaceId: true,
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

  // 26/10/2026 — los datos de Google se piden al enseñar el borrador (no se
  // pueden guardar; ver lib/web-draft-live.ts), con caché de una hora: abrirlo
  // y volver a abrirlo durante la llamada es una sola consulta.
  const live = await getLiveDraftData(lead.externalPlaceId);
  const baseSubject = {
    businessName,
    primaryType: lead.primaryType,
    city: lead.searchLocation,
    address: addressFromLeadSummary(lead.summary),
    phone: lead.contactPhone,
    rating: lead.competitorSnapshot?.subjectRating ?? null,
    reviewCount: lead.competitorSnapshot?.subjectReviewCount ?? null,
  };
  const liveReviews = live ? filterDraftReviews(live.reviews, businessName) : [];

  const url = new URL(req.url);
  const regenerate = url.searchParams.get('regenerar') === '1';

  let shareToken: string | null = lead.webDraft?.shareToken ?? null;
  let copy: WebDraftCopy | null =
    !regenerate && lead.webDraft ? (lead.webDraft.copy as unknown as WebDraftCopy) : null;
  let generatedAt = lead.webDraft?.generatedAt ?? new Date();
  // Webs con IA (27/10/2026): el diseño de la biblioteca, si su sector tiene
  // plantilla aprobada (web-draft-design.ts). Al regenerar se vuelve a elegir.
  let design: { content: unknown; templateId: string | null } = {
    content: lead.webDraft?.content ?? null,
    templateId: lead.webDraft?.templateId ?? null,
  };

  if (!copy) {
    const result = await generateWebDraftCopy({
      businessName,
      primaryType: lead.primaryType,
      category: lead.searchCategory,
      city: lead.searchLocation,
      address: live?.formattedAddress || baseSubject.address,
      phone: lead.contactPhone,
      rating: live?.rating ?? baseSubject.rating,
      reviewCount: live?.userRatingCount ?? baseSubject.reviewCount,
      reviews: liveReviews,
    });

    if ('skipped' in result) {
      return NextResponse.json({ error: 'no_api_key' }, { status: 503 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    copy = result.copy;
    generatedAt = new Date();
    const themeKey = themeFor(lead.primaryType).key;
    const designed = await designForDraft(prisma, {
      copy,
      themeKey,
      businessName,
      primaryType: lead.primaryType,
      city: lead.searchLocation,
      leadId: lead.id,
    });
    design = { content: designed?.content ?? null, templateId: designed?.templateId ?? null };
    const payload = {
      clientId: lead.clientId,
      tenantId: lead.tenantId,
      copy: copy as unknown as object,
      content: designed ? (designed.content as unknown as object) : Prisma.DbNull,
      templateId: designed?.templateId ?? null,
      themeKey,
      model: result.model,
      generatedAt,
    };
    try {
      // El testigo se crea UNA vez y no cambia al regenerar: un enlace que ya
      // mandaste por WhatsApp tiene que seguir abriendo aunque después
      // reescribas el texto.
      const upsert = prisma.prospectingWebDraft.upsert({
        where: { leadId: lead.id },
        create: { leadId: lead.id, ...payload, shareToken: createShareToken() },
        update: payload,
        select: { shareToken: true },
      });
      // 28/10/2026 — regenerar sustituye el borrador entero, retoques a mano
      // incluidos (scripts/borrador-web.ts). El anterior queda en el
      // historial, y la herramienta puede volver a él.
      const old = lead.webDraft;
      const saved = old
        ? (
            await prisma.$transaction([
              prisma.prospectingWebDraftVersion.create({
                data: {
                  draftId: old.id,
                  accion: 'regenerado',
                  actorId: auth.operatorId,
                  copy: old.copy as Prisma.InputJsonValue,
                  content: old.content === null ? Prisma.DbNull : (old.content as Prisma.InputJsonValue),
                  templateId: old.templateId,
                  themeKey: old.themeKey,
                },
              }),
              upsert,
            ])
          )[1]
        : await upsert;
      shareToken = saved.shareToken;
      // 29/10/2026 — regenerado y guardado: a la dirección sin ?regenerar=1.
      // Si no, recargar la pestaña (o volver a ella mañana) gastaría otra
      // generación y cambiaría otra vez el texto sin que nadie lo pidiera.
      // Relativa: detrás del proxy de la VPS, req.url lleva el host interno.
      if (regenerate) {
        url.searchParams.delete('regenerar');
        return new NextResponse(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, 'cache-control': 'private, no-store' } });
      }
    } catch (err) {
      // La generación ya está pagada: que no se pueda guardar no debe
      // impedir que el comercial vea el borrador que acaba de pedir.
      logError('web_draft.persist_failed', err, { leadId: lead.id }, 'warn');
    }
  }

  // El operador ve además el enlace público que puede copiar y mandar: sin
  // esto tendría que construirlo a mano, y el enlace de esta misma ruta NO
  // sirve — pedirá sesión al prospecto.
  const shareUrl = shareToken ? webDraftShareUrl(publicOrigin(req), shareToken) : null;
  const subject = withLiveData(baseSubject, live, copy);
  const themeKey = lead.webDraft?.themeKey ?? themeFor(lead.primaryType).key;
  const designed = await renderDesignedDraft(prisma, {
    templateId: design.templateId,
    content: design.content,
    subject,
    themeKey,
    shareUrl,
  });

  return new NextResponse(
    designed ?? renderWebDraftHtml({ subject, copy, generatedAt, shareUrl, themeKey: lead.webDraft?.themeKey ?? null }),
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
