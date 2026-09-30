import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isGooglePlacesConfigured } from '@/lib/google-places';
import { hashIp } from '@/lib/public-draft-request';
import { fotoDeZona, PROVINCIAS } from '@/lib/prospeccion-zona';
import { PUBLIC_SECTORS } from '@/lib/public-draft-request';
import { logError } from '@/lib/observability';
import { clientIpFromHeaders } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// El gancho de /prospeccion/ en kairikos.com: «¿cuántos negocios de tu rubro
// no tienen web en tu provincia?».
//
// El porqué del diseño y los tres frenos están en lib/prospeccion-zona.ts.
// Aquí solo lo que es propio de la ruta:
//
// - GET devuelve las dos listas cerradas, para que la web pinte los dos
//   desplegables sin tener su propia copia. Una tercera lista escrita a mano
//   en el tema es exactamente como el sitio acabó vendiendo a precios que no
//   se cobran.
//
// - POST devuelve PROPORCIONES. Nunca la lista de negocios: esa, con nombre,
//   teléfono y correo, es literalmente el producto.
//
// - Sin clave de Places configurada responde 503 y no una cifra inventada ni
//   un cero. Un cero aquí se leería como «no hay competencia».
// =============================================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const BodySchema = z.object({
  rubro: z.string().trim().max(40),
  provincia: z.string().trim().max(60),
  /** Campo trampa: una persona no lo ve. Igual que en el borrador público. */
  website: z.string().max(200).optional(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  return NextResponse.json(
    {
      rubros: Object.entries(PUBLIC_SECTORS)
        // 'otro' existe para el borrador de web, donde el sector solo elige
        // una plantilla. Aquí sería una búsqueda sin sentido: «Otro en
        // Cuenca» no devuelve nada que signifique algo.
        .filter(([clave]) => clave !== 'otro')
        .map(([clave, s]) => ({ clave, etiqueta: s.label })),
      provincias: PROVINCIAS,
    },
    { status: 200, headers: { ...CORS, 'cache-control': 'public, max-age=86400' } },
  );
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'no_disponible' }, { status: 503, headers: CORS });
  }
  if (!(await isGooglePlacesConfigured())) {
    return NextResponse.json({ error: 'no_disponible' }, { status: 503, headers: CORS });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalido' }, { status: 400, headers: CORS });
  }
  if (body.data.website && body.data.website.trim().length > 0) {
    // Un bot rellenó la trampa. Se responde 400 como a cualquier petición
    // mal formada: decirle que se le ha calado solo ayuda a que afine.
    return NextResponse.json({ error: 'invalido' }, { status: 400, headers: CORS });
  }

  // La IP que ve el proxy, no la primera de X-Forwarded-For, que la escribe
  // quien llama: cambiándola en cada petición se saltaba el tope por IP
  // (revisión de seguridad del 30/09/2026). Ver client-ip.ts.
  const ip = clientIpFromHeaders(req.headers);

  try {
    const r = await fotoDeZona(prisma, {
      rubro: body.data.rubro,
      provincia: body.data.provincia,
      ipHash: hashIp(ip),
    });

    if (!r.ok) {
      // 429 solo para los topes, que son nuestros y se pasan solos. El resto va
      // con 400, incluido 'muestra_insuficiente': la petición está bien formada
      // y la zona existe, simplemente da demasiado poco para decir una
      // proporción. El código sale tal cual porque la web escribe un texto
      // distinto para cada uno — un «no se pudo» genérico ahí sería mentira.
      const estado = r.error === 'tope_global' || r.error === 'tope_ip' ? 429 : 400;
      return NextResponse.json({ error: r.error }, { status: estado, headers: CORS });
    }

    // `deCache` no sale: al visitante no le dice nada y publicar el estado de
    // la caché solo sirve para que alguien la sondee.
    return NextResponse.json(
      { sinWeb: r.foto.sinWeb, total: r.foto.total, miradoEl: r.foto.miradoEl },
      { status: 200, headers: CORS },
    );
  } catch (error) {
    logError('prospeccion_zona_route', error);
    return NextResponse.json({ error: 'no_disponible' }, { status: 503, headers: CORS });
  }
}
