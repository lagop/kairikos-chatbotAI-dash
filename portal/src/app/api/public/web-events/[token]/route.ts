import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { clientIpFromHeaders } from '@/lib/client-ip';
import { localDateFor } from '@/lib/recall-digest';
import { allowWebEvent, findSiteByEventsToken, recordWebEvent } from '@/lib/web-events';
import {
  isAcceptedContentType,
  isBotUserAgent,
  isEventsTokenShape,
  MAX_WEB_EVENT_BYTES,
  originMatchesSite,
  parseWebEvent,
  WEB_RESULTS_TIMEZONE,
} from '@/lib/web-events-rules';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/public/web-events/[token]
 *
 * Informe mensual de resultados (28/11/2026). La web Premium del cliente
 * manda aquí, con navigator.sendBeacon, cada llegada y cada clic que importa
 * (llamar, WhatsApp, email, formulario, reserva, chat). Contrato completo en
 * docs/informe-mensual-web.md; reglas en lib/web-events-rules.ts.
 *
 *   Cuerpo  {"k": tipo, "s": origen}, como text/plain (sendBeacon con una
 *           cadena: sin preflight) o application/json. Máximo 512 bytes.
 *   Siempre 204, cuente o no: token desconocido, tipo inválido, origen que no
 *           es la web, bot o límite superado. La web no lee la respuesta, y
 *           un 404 distinto diría a quien prueba tokens cuáles existen.
 *
 * CORS «*», como villas: el navegador lo exige para un POST de otro origen,
 * aunque sendBeacon no lea la respuesta. La comprobación de que el evento
 * viene de la web del cliente es la de `siteUrl`, más abajo.
 *
 * PRIVACIDAD. Solo se guardan contadores agregados por día (sitio, día, tipo,
 * origen, total). Ni cookies, ni identificadores, ni nada guardado en el
 * dispositivo del visitante; ni IP ni navegador en la base de datos. La IP
 * se usa solo en memoria, un minuto, para el límite de abuso.
 */
// REVISAR ABOGADO: base jurídica de la medición agregada sin cookies

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function noContent() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return noContent();
}

export async function POST(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  try {
    if (!isDatabaseConfigured) return noContent();
    const { token } = await props.params;
    if (!isEventsTokenShape(token)) return noContent();
    if (isBotUserAgent(req.headers.get('user-agent'))) return noContent();
    if (!isAcceptedContentType(req.headers.get('content-type'))) return noContent();

    // Primero la cabecera, para no leer un cuerpo grande; luego el cuerpo,
    // porque Content-Length puede faltar o mentir.
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_WEB_EVENT_BYTES) return noContent();
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_WEB_EVENT_BYTES) return noContent();

    const event = parseWebEvent(raw);
    if (!event) return noContent();

    // El límite va antes de la consulta: un bucle no debe costar una lectura
    // de Postgres por petición.
    if (!allowWebEvent(clientIpFromHeaders(req.headers), token)) return noContent();

    const site = await findSiteByEventsToken(prisma, token);
    if (!site) return noContent();

    if (site.siteUrl) {
      const from = req.headers.get('origin') || req.headers.get('referer');
      if (!originMatchesSite(from, site.siteUrl)) return noContent();
    }

    await recordWebEvent(prisma, {
      clientSiteId: site.id,
      day: localDateFor(new Date(), WEB_RESULTS_TIMEZONE),
      event,
    });
    return noContent();
  } catch (err) {
    // Un evento perdido no es un error para el visitante: 204 igual.
    logError('web_events.record_failed', err, {}, 'warn');
    return noContent();
  }
}
