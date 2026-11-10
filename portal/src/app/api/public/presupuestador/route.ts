import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { createPremiumQuoteRequest, loadResolvedQuoter, notifyPremiumQuote } from '@/lib/premium-quoter';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// /api/public/presupuestador — el presupuestador de Web Premium.
//
// GET  (10/11/2026) los datos ya con los precios del catálogo, para el script
//      que lo pinta dentro de kairikos.com (src/embed/presupuestador.tsx). 404
//      mientras no esté publicado: el script entonces no pinta nada.
// POST (09/11/2026) la solicitud del formulario. Sin la casilla de privacidad
//      marcada no se guarda nada (`consent` tiene que ser exactamente true), y
//      `estimacion` ni se lee: el importe lo calcula el lib.
//
// CORS solo para kairikos.com: hasta el 10/11 la página iba en un marco del
// propio portal y las peticiones eran del mismo origen. Ahora el script corre
// en la página de kairikos.com y sus peticiones salen de allí. En desarrollo
// también se acepta localhost, para probarlo desde una página de otro puerto.
// =============================================================================

const ALLOWED_ORIGINS = new Set(['https://kairikos.com', 'https://www.kairikos.com']);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin !== null && (ALLOWED_ORIGINS.has(origin) || (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)));
  return allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(req.headers.get('origin')),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(req: NextRequest) {
  const headers = { ...corsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store' };
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'unavailable' }, { status: 503, headers });
  try {
    const loaded = await loadResolvedQuoter(prisma);
    if (!loaded.ok || !loaded.quoter.config.published) return NextResponse.json({ error: 'not_available' }, { status: 404, headers });
    return NextResponse.json({ quoter: loaded.quoter }, { headers });
  } catch (err) {
    logError('premium_quoter.load_failed', err, {});
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers });
  }
}

const BodySchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  empresa: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(200),
  tel: z.string().trim().max(40).optional(),
  web: z.string().trim().max(300).optional(),
  franja: z.string().trim().max(40),
  sector: z.string().trim().max(40),
  respuestas: z.record(z.unknown()),
  consent: z.literal(true),
  /** El campo trampa. Una persona no lo ve. */
  website: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req.headers.get('origin'));
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  if (!isDatabaseConfigured) return reply({ error: 'unavailable' }, 503);

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return reply({ error: 'invalid' }, 400);

  const { website, ...input } = body.data;
  try {
    const result = await createPremiumQuoteRequest(prisma, { ...input, trap: website, ip: clientIpFromHeaders(req.headers) });
    if (!result.ok) {
      const status = result.error === 'invalid' ? 400 : result.error === 'not_available' ? 404 : 429;
      return reply({ error: result.error }, status);
    }
    if (result.saved) {
      const { id, quoter, estimate } = result.saved;
      after(() =>
        notifyPremiumQuote({ id, quoter, estimate, sector: input.sector, nombre: input.nombre, empresa: input.empresa, email: input.email, tel: input.tel, franja: input.franja }),
      );
    }
    return reply({ ok: true });
  } catch (err) {
    logError('premium_quoter.create_failed', err, {});
    return reply({ error: 'unavailable' }, 503);
  }
}
