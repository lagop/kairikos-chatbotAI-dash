import 'server-only';
import { NextResponse } from 'next/server';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';

// =============================================================================
// Reserva propia para villas — lo común de las rutas públicas del widget.
//
// Abiertas a internet y con CORS «*»: las llama el navegador de cada visitante
// desde la web del cliente, cuyo dominio no se conoce de antemano (misma
// postura que /api/public/channels/web/*). El token vil_… es la única
// credencial y no es un secreto.
//
// El límite se cuenta por token y no por IP: detrás de una IP puede haber una
// oficina entera. Es holgado en lectura (frena bucles) y estricto al enviar.
// =============================================================================

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const readLimiter = new InMemoryRateLimiter(60 * 1000);
const writeLimiter = new InMemoryRateLimiter(60 * 60 * 1000);
export const READS_PER_MINUTE = 240;
/** Solicitudes por web y hora. Una villa no recibe veinte solicitudes reales
 *  en una hora; un formulario atacado sí. */
export const REQUESTS_PER_HOUR = 20;

export function allowRead(token: string): boolean {
  return readLimiter.check(`villas-read:${token}`, READS_PER_MINUTE);
}

export function allowWrite(token: string): boolean {
  return writeLimiter.check(`villas-write:${token}`, REQUESTS_PER_HOUR);
}

export function corsJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...CORS_HEADERS, ...extra } });
}

export function corsPreflight() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Lee un entero de la query con límites; fuera de rango o ausente, `fallback`. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}
