import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { captureCompetitorSnapshot } from '@/lib/prospecting-competitors';
import { buildReportModel, type MissedCallAssumptions } from '@/lib/prospecting-report';
import { renderProspectingReportHtml } from '@/lib/prospecting-report-html';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// A1 · GET /api/admin/portal/prospecting/report/[leadId]
//
// Devuelve el informe de un prospecto como página HTML, lista para
// enseñar en la llamada o mandar por WhatsApp.
//
// Es ruta de OPERADOR, no de cliente: hoy el que prospecta es Kairikos con
// su propia campaña, y el informe cuesta una llamada de pago a Google por
// prospecto. Abrirlo a /api/portal/* sin más lo convertiría en un botón que
// cualquier cliente puede pulsar cientos de veces sobre su lista de leads,
// y el tope mensual de la campaña no cubre este gasto: cuenta llamadas a
// Place Details, no búsquedas. Cuando el informe se ofrezca al cliente hará
// falta su propio cupo.
//
// Los tres supuestos del cálculo llegan por query string porque se ajustan
// EN la llamada, hablando con el negocio ("¿cuántas se te escapan?"). Van
// saneados en prospecting-report.ts, no aquí: la ruta es fina.
// =============================================================================

function number(param: string | null): number | undefined {
  if (param === null) return undefined;
  const n = Number(param);
  return Number.isFinite(n) ? n : undefined;
}

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
      externalPlaceId: true,
      contactName: true,
      contactPhone: true,
      website: true,
      summary: true,
      latitude: true,
      longitude: true,
      primaryType: true,
      searchCategory: true,
      searchLocation: true,
    },
  });
  if (!lead) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const url = new URL(req.url);
  const assumptions: Partial<MissedCallAssumptions> = {
    missedCallsPerWeek: number(url.searchParams.get('llamadas')),
    averageJobValue: number(url.searchParams.get('encargo')),
    closeRate: number(url.searchParams.get('cierre')),
  };

  const snapshot = await captureCompetitorSnapshot(
    prisma,
    {
      leadId: lead.id,
      clientId: lead.clientId,
      tenantId: lead.tenantId,
      placeId: lead.externalPlaceId,
      name: lead.contactName,
      latitude: lead.latitude,
      longitude: lead.longitude,
      primaryType: lead.primaryType,
      searchCategory: lead.searchCategory,
      searchLocation: lead.searchLocation,
    },
    { force: url.searchParams.get('refrescar') === '1' },
  );

  if (!snapshot.ok) {
    // Errores distintos, remedios distintos: sin clave de Places es
    // configuración del operador; un lead sin rubro no se arregla tocando
    // nada. Se devuelven como JSON porque quien los ve es el operador.
    const status = snapshot.error === 'not_configured' ? 503 : 422;
    return NextResponse.json({ error: snapshot.error }, { status });
  }

  const model = buildReportModel({
    subject: {
      name: lead.contactName ?? 'Este negocio',
      rating: snapshot.data.subjectRating,
      reviewCount: snapshot.data.subjectReviewCount,
      // El barrido guarda la dirección dentro de `summary` como frase
      // ("Negocio encontrado en …"); se recorta aquí en vez de cambiar lo
      // que escribe prospecting.ts, que es lo que ve el cliente en su lista.
      address: lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
      phone: lead.contactPhone,
      website: lead.website,
      category: lead.searchCategory,
      location: lead.searchLocation,
      // Decide el encargo medio de partida: 30 € en una peluquería, 300 € en
      // una fontanería. Ver JOB_VALUE_BY_PRIMARY_TYPE.
      primaryType: lead.primaryType,
    },
    competitors: snapshot.data.competitors,
    assumptions,
    capturedAt: snapshot.data.capturedAt,
  });

  return new NextResponse(renderProspectingReportHtml(model), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Información de un negocio de terceros: ni caché compartida ni
      // buscadores. La frescura real la gobierna el TTL del snapshot.
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
