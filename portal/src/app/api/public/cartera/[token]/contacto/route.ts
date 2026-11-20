import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findSiteByFeedToken } from '@/lib/cartera/site';
import { allowEnquiry, enquiryCorsHeaders, enquiryJson } from '@/lib/cartera/public-http';
import { enquirySchema, isHoneypot } from '@/lib/cartera/enquiry-rules';
import { receiveEnquiry } from '@/lib/cartera/enquiries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/public/cartera/[token]/contacto
 *
 * Cartera — los siete formularios de la web (visita, valoración, propietarios,
 * fuera de mercado, informe, y las dos de casas guardadas). Contrato:
 * docs/contactos.md de la plantilla; la web lo cumple en src/scripts/lead.ts.
 *
 *   2xx  guardado, o trampa llena (`website`: se responde 200 y no se guarda nada)
 *   400  no valida, o en guardadas no queda ninguna casa publicada
 *   404  token desconocido o contratación no activa
 *   429  20 por hora y token, o 3 al día al mismo email en «mándamela por email»
 *
 * La web no lee el cuerpo de la respuesta. CORS solo para el origen de
 * `siteUrl`. La lógica, en lib/cartera/enquiries.ts.
 */
export async function OPTIONS(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  if (!isDatabaseConfigured) return new NextResponse(null, { status: 503 });
  const { token } = await props.params;
  const site = await findSiteByFeedToken(prisma, token);
  if (!site) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 204, headers: enquiryCorsHeaders(site.siteUrl) });
}

export async function POST(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  if (!isDatabaseConfigured) return NextResponse.json({ ok: false, error: 'service_unavailable' }, { status: 503 });
  const { token } = await props.params;
  const site = await findSiteByFeedToken(prisma, token);
  if (!site) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  const raw = await req.json().catch(() => null);
  // Un bot: parece que ha ido bien y no se guarda nada (ni cuenta para el límite).
  if (isHoneypot(raw)) return enquiryJson(site.siteUrl, { ok: true }, 200);
  if (!allowEnquiry(token)) return enquiryJson(site.siteUrl, { ok: false, error: 'too_many_requests' }, 429);

  const body = enquirySchema.safeParse(raw);
  if (!body.success) return enquiryJson(site.siteUrl, { ok: false, error: 'invalid_body' }, 400);

  const r = await receiveEnquiry(prisma, { id: site.id, clientId: site.clientId, tenantId: site.tenantId, siteUrl: site.siteUrl }, body.data);
  if (!r.ok) return enquiryJson(site.siteUrl, { ok: false, error: r.error }, r.error === 'recipient_limit' ? 429 : 400);
  return enquiryJson(site.siteUrl, { ok: true }, 201);
}
