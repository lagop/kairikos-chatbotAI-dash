import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { createPublicDraft, generatePublicDraft, PUBLIC_SECTORS } from '@/lib/public-draft-request';
import { publicOrigin } from '@/lib/public-origin';
import { logError } from '@/lib/observability';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { emailFromContact } from '@/lib/inbound-follow-up';

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
//
// 30/10/2026 — contesta al momento y el borrador se escribe DESPUÉS de
// contestar (after), para entregarlo en menos de 24 horas
// (public-draft-delivery.ts). Pide correo, que es por donde le llega; el
// teléfono es opcional. Mientras kairikos.com no cambie su formulario, sigue
// aceptando el campo de antes («contact», teléfono o correo).
// =============================================================================

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const BodySchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  city: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  /** El campo del formulario antiguo: teléfono o correo. */
  contact: z.string().trim().min(6).max(200).optional(),
  sector: z.string().trim().max(40),
  /** 20/10/2026 — la casilla de comunicaciones comerciales, desmarcada por
   *  defecto. El contacto obligatorio sirve para seguir la conversación sobre
   *  SU borrador; escribirle con otras ofertas exige esto a true. */
  consent: z.boolean().optional(),
  /** El campo trampa. Se llama 'website' porque es lo que un bot espera ver
   *  y rellenar; una persona no lo ve. */
  website: z.string().max(200).optional(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * La lista de sectores, para que el formulario de kairikos.com la pinte.
 *
 * Existe por lo mismo que la de /api/public/prospeccion-zona: una copia escrita
 * a mano en el tema de WordPress es la que se queda atrás el día que se añade
 * un sector, y así es exactamente como el sitio acabó vendiendo a precios que
 * no se cobraban.
 *
 * Aquí «otro» SÍ sale, al revés que en prospección. Allí era una búsqueda sin
 * sentido —«Otro en Cuenca» no devuelve nada—; aquí solo elige la plantilla del
 * borrador, así que es una respuesta legítima y quien no encaje en los once
 * debe poder decirlo en vez de mentir.
 */
export async function GET() {
  return NextResponse.json(
    { sectores: Object.entries(PUBLIC_SECTORS).map(([clave, s]) => ({ clave, etiqueta: s.label })) },
    { status: 200, headers: { ...CORS, 'cache-control': 'public, max-age=86400' } },
  );
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: CORS });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: CORS });
  }

  // La IP que ve el proxy (client-ip.ts). Hasta el 30/09/2026 se leía la
  // primera entrada de X-Forwarded-For, que escribe quien llama: el tope por
  // IP no frenaba a nadie y un script podía agotar el global del día.
  const ip = clientIpFromHeaders(req.headers);

  try {
    const { consent, email, phone, contact, ...draft } = body.data;
    const legacyEmail = contact ? emailFromContact(contact) : null;
    const result = await createPublicDraft(prisma, {
      ...draft,
      email: email || legacyEmail,
      phone: phone || (contact && !legacyEmail ? contact : null),
      marketingConsent: consent === true,
      ip,
    });
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

    // Se escribe después de contestar; si falla, lo reintenta el barrido.
    const id = result.id;
    after(() => generatePublicDraft(prisma, id));

    return NextResponse.json(
      { ok: true, url: `${publicOrigin(req)}/mi-web/${result.token}` },
      { headers: CORS },
    );
  } catch (err) {
    logError('public_draft.request_failed', err, { route: 'api/public/web-draft' }, 'warn');
    return NextResponse.json({ error: 'unavailable' }, { status: 500, headers: CORS });
  }
}

