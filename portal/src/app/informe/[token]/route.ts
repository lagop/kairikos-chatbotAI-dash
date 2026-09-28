import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { buildReportModel, type CompetitorInput, type MissedCallAssumptions } from '@/lib/prospecting-report';
import { renderProspectingReportHtml } from '@/lib/prospecting-report-html';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function number(param: string | null): number | undefined {
  if (param === null) return undefined;
  const n = Number(param);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A1 — GET /informe/[token]
 *
 * El informe comparativo tal y como lo recibe el prospecto por WhatsApp.
 * Público por la misma razón que /borrador/[token]: quien lo abre no tiene
 * sesión ni motivo para tenerla.
 *
 * Solo lee la foto de la zona ya capturada. NO llama a Google: sin snapshot
 * guardado, 404. Capturar sigue siendo de la ruta de operador.
 *
 * Los supuestos del cálculo siguen aceptándose por query string, porque el
 * comercial ajusta la cifra hablando ("¿cuántas llamadas se te escapan?") y
 * manda el enlace ya con SU número: /informe/<token>?llamadas=5&encargo=800.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  if (!isShareToken(params.token)) {
    return new NextResponse('Enlace no válido.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (!isDatabaseConfigured) {
    return new NextResponse('No disponible.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  try {
    const snapshot = await prisma.prospectingCompetitorSnapshot.findUnique({
      where: { shareToken: params.token },
      select: {
        subjectRating: true,
        subjectReviewCount: true,
        competitors: true,
        capturedAt: true,
        lead: {
          select: {
            contactName: true,
            contactPhone: true,
            website: true,
            summary: true,
            primaryType: true,
            searchCategory: true,
            searchLocation: true,
          },
        },
      },
    });

    if (!snapshot) {
      return new NextResponse('Este enlace ya no está disponible.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const url = new URL(req.url);
    const assumptions: Partial<MissedCallAssumptions> = {
      missedCallsPerWeek: number(url.searchParams.get('llamadas')),
      averageJobValue: number(url.searchParams.get('encargo')),
      closeRate: number(url.searchParams.get('cierre')),
    };

    const model = buildReportModel({
      subject: {
        name: snapshot.lead.contactName ?? 'Este negocio',
        rating: snapshot.subjectRating,
        reviewCount: snapshot.subjectReviewCount,
        address: snapshot.lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
        phone: snapshot.lead.contactPhone,
        website: snapshot.lead.website,
        category: snapshot.lead.searchCategory,
        location: snapshot.lead.searchLocation,
        primaryType: snapshot.lead.primaryType,
      },
      competitors: snapshot.competitors as unknown as CompetitorInput[],
      assumptions,
      capturedAt: snapshot.capturedAt,
    });

    return new NextResponse(renderProspectingReportHtml(model), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch (err) {
    logError('prospecting_report.public_view_failed', err, { route: 'app/informe/[token]' }, 'warn');
    return new NextResponse('No hemos podido mostrar esta página.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
