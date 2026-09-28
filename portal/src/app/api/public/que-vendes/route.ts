import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { hashIp } from '@/lib/public-draft-request';
import { queVendes, LARGO_MAXIMO } from '@/lib/que-vendes-publico';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// «¿Qué vendes?» — el gancho de /prospeccion/ en kairikos.com.
//
// El porqué y los frenos están en lib/que-vendes-publico.ts. Lo propio de la
// ruta:
//
// - NO hay GET: la lista de provincias ya la publica /api/public/prospeccion-zona,
//   y una tercera copia sería la que se queda atrás.
//
// - Cada código de error sale tal cual, porque la página escribe un texto para
//   cada uno. «Vuelve en un rato» es verdad cuando el modelo no responde y es
//   mentira cuando el texto es demasiado corto — la corrección del 27/09 en el
//   buscador de zona vale igual aquí.
// =============================================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const BodySchema = z.object({
  // Un poco de holgura sobre LARGO_MAXIMO para que el lib, y no zod, sea quien
  // diga «demasiado largo» con su propio código de error.
  texto: z.string().max(LARGO_MAXIMO + 100),
  provincia: z.string().max(60).optional(),
  /** Campo trampa. */
  website: z.string().max(200).optional(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'no_disponible' }, { status: 503, headers: CORS });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'demasiado_corto' }, { status: 400, headers: CORS });
  }
  if (body.data.website && body.data.website.trim().length > 0) {
    return NextResponse.json({ error: 'demasiado_corto' }, { status: 400, headers: CORS });
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'desconocida';

  try {
    const r = await queVendes(prisma, {
      texto: body.data.texto,
      provincia: body.data.provincia ?? null,
      ipHash: hashIp(ip),
    });

    if (!r.ok) {
      const estado =
        r.error === 'tope_global' || r.error === 'tope_ip' ? 429
        : r.error === 'no_disponible' ? 503
        : 400;
      return NextResponse.json({ error: r.error }, { status: estado, headers: CORS });
    }

    return NextResponse.json(r.propuesta, { status: 200, headers: CORS });
  } catch (error) {
    logError('que_vendes_route', error);
    return NextResponse.json({ error: 'no_disponible' }, { status: 503, headers: CORS });
  }
}
