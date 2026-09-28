import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { handleWebsiteFormSubmission, isFormToken } from '@/lib/website-form';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Producto Web, Fase 1 — el buzón del formulario de las webs publicadas.
//
// PÚBLICA y CROSS-ORIGIN a propósito: quien llama es el navegador de un
// visitante que está en la web del cliente, en el dominio del cliente. No hay
// sesión posible, igual que en /r/[requestId] o en /borrador/[token].
//
// Lo que la protege no es la autenticación, es que no hay nada que sacar:
// solo escribe un lead en la bandeja de UN cliente concreto (el del testigo)
// y responde ok. No lee nada, no lista nada y no distingue un testigo
// inexistente de uno válido en el tiempo de respuesta de forma útil.
//
// El tope de 20 envíos por hora y sitio vive en el lib. Un formulario
// público sin tope es un bot dejando cien basuras en la bandeja del cliente
// en un minuto, y con ellas la sensación de que el producto no sirve.
// =============================================================================

const BodySchema = z.object({
  name: z.string().trim().max(200).default(''),
  contact: z.string().trim().min(3).max(200),
  message: z.string().trim().max(2000).default(''),
});

/** CORS abierto: la web de cada cliente vive en su propio dominio y no
 *  tenemos una lista de esos dominios (ni queremos mantenerla — un cambio de
 *  dominio del cliente rompería su formulario en silencio). Es aceptable
 *  porque el endpoint solo escribe en un buzón concreto y no devuelve nada
 *  que valga la pena robar. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest, { params }: { params: { formToken: string } }) {
  if (!isFormToken(params.formToken)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: CORS });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: CORS });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: CORS });
  }

  try {
    const result = await handleWebsiteFormSubmission(prisma, params.formToken, body.data);
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : result.error === 'rate_limited' ? 429 : 400;
      return NextResponse.json({ error: result.error }, { status, headers: CORS });
    }
    // Al visitante no se le dice a dónde fue su mensaje (bandeja o correo):
    // eso es asunto interno del cliente y del contrato que tenga con
    // nosotros.
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (err) {
    logError('website_form.submission_failed', err, { route: 'api/public/website-form' }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: CORS });
  }
}
