import 'server-only';
import { NextResponse } from 'next/server';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';
import { ENQUIRIES_PER_HOUR } from './enquiry-rules';

// =============================================================================
// Cartera — límites de las rutas públicas, como lib/villas/public-http.ts.
//
// Por token y no por IP: el feed lo pide el runner de GitHub, cuya IP cambia
// en cada build. Un build pide el feed una o dos veces; el límite solo frena
// un bucle o un token filtrado que alguien martillea.
//
// El formulario de contacto (PR 5) tiene su propio límite, más estricto, y
// CORS: lo llama el navegador del comprador. A diferencia de villas («*»), aquí
// se conoce la web de antemano (`siteUrl`), así que solo se abre a su origen.
// =============================================================================

// Contactos: 20 por hora y token (fase1-cartera.md, «Rutas»).
const enquiryLimiter = new InMemoryRateLimiter(60 * 60 * 1000);

export function allowEnquiry(token: string): boolean {
  return enquiryLimiter.check(`cartera-enquiry:${token}`, ENQUIRIES_PER_HOUR);
}

/** El origen de la web del cliente, o null si `siteUrl` no está o no es una URL. */
export function siteOrigin(siteUrl: string | null): string | null {
  if (!siteUrl) return null;
  try {
    const u = new URL(siteUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** CORS solo para el origen de la web. Sin `siteUrl`, sin cabecera: el navegador
 *  no deja leer la respuesta y el formulario enseña el teléfono de la agencia. */
export function enquiryCorsHeaders(siteUrl: string | null): Record<string, string> {
  const origin = siteOrigin(siteUrl);
  const base = { Vary: 'Origin' };
  if (!origin) return base;
  return {
    ...base,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export function enquiryJson(siteUrl: string | null, body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: enquiryCorsHeaders(siteUrl) });
}

const feedLimiter = new InMemoryRateLimiter(60 * 1000);
export const FEED_READS_PER_MINUTE = 30;

export function allowFeedRead(token: string): boolean {
  return feedLimiter.check(`cartera-feed:${token}`, FEED_READS_PER_MINUTE);
}

// Avisos de publicación: dos por ejecución (curl los reintenta hasta tres
// veces). Treinta por minuto y token sobra para cualquier uso legítimo.
const noticeLimiter = new InMemoryRateLimiter(60 * 1000);
export const NOTICES_PER_MINUTE = 30;

export function allowBuildNotice(token: string): boolean {
  return noticeLimiter.check(`cartera-notice:${token}`, NOTICES_PER_MINUTE);
}
