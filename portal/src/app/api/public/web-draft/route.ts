import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { createPublicDraft } from '@/lib/public-draft-request';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// =============================================================================
// A11, capa 3 — POST /api/public/web-draft
//
// Lo llama el formulario "Ver cómo quedaría mi web" de kairikos.com, que vive
// en otro dominio: de ahí el CORS. Pública porque quien la usa es un negocio
// que todavía no nos conoce; pedirle una cuenta antes de enseñarle nada sería
// perder al 95 %.
//
// Los frenos viven en el lib (tope global del día, tope por IP, contacto
// obligatorio y campo trampa). Aquí solo se traduce el resultado a una
// respuesta que el formulario pueda enseñar sin asustar a nadie.
// =============================================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const BodySchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  city: z.string().trim().min(2).max(120),
  contact: z.string().trim().min(6).max(200),
  sector: z.string().trim().max(40),
  /** El campo trampa. Se llama 'website' porque es lo que un bot espera ver
   *  y rellenar; una persona no lo ve. */
  website: z.string().max(200).optional(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: CORS });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: CORS });
  }

  // La IP real viene del proxy. Sin cabecera, cadena vacía: el tope por IP
  // deja de discriminar pero el GLOBAL sigue en pie, que es el que de verdad
  // acota el gasto.
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();

  try {
    const result = await createPublicDraft(prisma, { ...body.data, ip });
    if (!result.ok) {
      // Al visitante no se le explica cuál de los topes saltó: no puede
      // hacer nada con esa información y saberlo solo ayuda a quien intenta
      // saltárselos.
      const status = result.error === 'invalid' ? 400 : result.error === 'unavailable' ? 503 : 429;
      const message =
        result.error === 'invalid'
          ? 'invalid'
          : result.error === 'unavailable'
            ? 'unavailable'
            : 'rate_limited';
      return NextResponse.json({ error: message }, { status, headers: CORS });
    }

    return NextResponse.json(
      { ok: true, url: `${new URL(req.url).origin}/mi-web/${result.token}` },
      { headers: CORS },
    );
  } catch (err) {
    logError('public_draft.request_failed', err, { route: 'api/public/web-draft' }, 'warn');
    return NextResponse.json({ error: 'unavailable' }, { status: 500, headers: CORS });
  }
}

