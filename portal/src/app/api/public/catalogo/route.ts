import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { loadPublicCatalog } from '@/lib/public-catalog';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// El catálogo público, para que kairikos.com deje de adivinar los precios.
//
// El porqué está en lib/public-catalog.ts. Lo que importa aquí:
//
// - Es de SOLO LECTURA y sin autenticar, como la calculadora. Lo que devuelve
//   ya está publicado en /planes/; no hay nada que proteger. Si algún día
//   saliera de aquí algo que no está en esa página, el error es la consulta,
//   no la falta de una clave.
//
// - NO lo llama el navegador del visitante. Lo llama un script del repositorio
//   de los temas para generar un PHP commiteado, y una comprobación por cron
//   que avisa cuando ese PHP se queda atrás. El CORS abierto está igualmente
//   porque no cuesta nada y ahorra la sorpresa del día que alguien sí quiera
//   leerlo desde el navegador.
//
// - Si no hay base de datos configurada devuelve 503 y no un catálogo vacío.
//   Un catálogo vacío sería peor que un error: el generador escribiría un
//   archivo sin productos, la comprobación diría que todo está al día, y la
//   web se quedaría sin precios sin que nada fallara. Exactamente la clase de
//   avería silenciosa que esta ruta existe para evitar.
// =============================================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'database_unavailable' }, { status: 503, headers: CORS });
  }

  try {
    const catalog = await loadPublicCatalog(prisma);

    if (catalog.products.length === 0) {
      // Ídem: cero productos activos no es una respuesta válida, es un síntoma.
      return NextResponse.json({ error: 'empty_catalog' }, { status: 503, headers: CORS });
    }

    return NextResponse.json(catalog, {
      status: 200,
      headers: {
        ...CORS,
        // Diez minutos. Quien lo consume corre una vez al día; el margen es
        // para no castigar un reintento.
        'cache-control': 'public, max-age=600',
      },
    });
  } catch (error) {
    logError('public_catalog_failed', error);
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: CORS });
  }
}
