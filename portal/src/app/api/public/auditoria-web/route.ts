import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { hashIp } from '@/lib/public-draft-request';
import { fotoDeWeb } from '@/lib/auditoria-publica';
import { logError } from '@/lib/observability';
import { clientIpFromHeaders } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// El gancho de /seo/ en kairikos.com: «dinos tu web y te decimos qué le falta».
//
// El porqué del diseño y de los dos topes está en lib/auditoria-publica.ts. Lo
// propio de la ruta:
//
// - NO hay GET con una lista. La foto de zona lo tenía porque sus dos listas
//   cerradas son el freno y la web necesitaba pintarlas; aquí la entrada es un
//   campo de texto y no hay nada que publicar.
//
// - Salen SEIS NÚMEROS, nunca el título ni la descripción de la web ajena. Para
//   decir «tu título son 78 caracteres» basta el 78, y devolver el texto
//   convertiría esto en un proxy de lectura con nuestra IP delante.
//
// - Una web que no contesta se dice como lo que es. 'no_alcanzable' no es un
//   fallo nuestro y decirle al visitante «vuelve en un rato» sería mentirle:
//   esa fue exactamente la corrección del 27/09 en el buscador de zona.
// =============================================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const BodySchema = z.object({
  url: z.string().trim().max(300),
  /** Campo trampa: una persona no lo ve. Igual que en las otras dos públicas. */
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
    return NextResponse.json({ error: 'url_invalida' }, { status: 400, headers: CORS });
  }
  if (body.data.website && body.data.website.trim().length > 0) {
    // Un bot rellenó la trampa. Se responde como a cualquier petición mal
    // formada: decirle que se le ha calado solo le ayuda a afinar.
    return NextResponse.json({ error: 'url_invalida' }, { status: 400, headers: CORS });
  }

  // La IP que ve el proxy, no la primera de X-Forwarded-For, que la escribe
  // quien llama: cambiándola en cada petición se saltaba el tope por IP
  // (revisión de seguridad del 30/09/2026). Ver client-ip.ts.
  const ip = clientIpFromHeaders(req.headers);

  try {
    const r = await fotoDeWeb(prisma, { url: body.data.url, ipHash: hashIp(ip) });

    if (!r.ok) {
      // 429 solo para los topes, que son nuestros. 'url_invalida' y
      // 'no_alcanzable' son 400: la petición llegó bien y la respuesta es que
      // esa web no se puede mirar.
      const estado = r.error === 'tope_global' || r.error === 'tope_ip' ? 429 : 400;
      return NextResponse.json({ error: r.error }, { status: estado, headers: CORS });
    }

    return NextResponse.json(r.foto, { status: 200, headers: CORS });
  } catch (error) {
    logError('auditoria_publica_route', error);
    return NextResponse.json({ error: 'no_disponible' }, { status: 503, headers: CORS });
  }
}
