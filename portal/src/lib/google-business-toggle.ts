import 'server-only';
import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveReviewConnection } from './review-locations';
import { resolveClientFromSession } from './portal-session';
import { getSession } from './session';
import { hasGoogleBusinessConnectAccess } from './google-business';

// =============================================================================
// Fase 5 — el preámbulo compartido de los interruptores de la conexión de
// Google.
//
// Existía uno (autoPublishReplies) y ahora hay dos (autoRequestFromLeads).
// Los dos hacen literalmente lo mismo antes de escribir: sesión de
// cliente, acceso al producto, y resolver DE QUÉ UBICACIÓN se habla. Se
// extrae ahora, antes de que diverjan, que es cuando sale barato.
//
// Lo que NO se comparte, a propósito: el esquema del cuerpo, las columnas
// que se escriben y la forma de la respuesta. Son ajustes distintos con
// consecuencias distintas y cada ruta se lee entera en su archivo.
// =============================================================================

export type ToggleTarget =
  | { ok: true; clientId: string; connectionId: string }
  | { ok: false; response: NextResponse };

/**
 * Autentica, autoriza y resuelve la ubicación sobre la que actúa un
 * interruptor de la conexión de Google.
 *
 * `connectionId` es opcional porque un cliente de un solo local no lo
 * manda: se resuelve el suyo. Con varios locales y sin indicar cuál,
 * `resolveReviewConnection` devuelve null a propósito y esto responde
 * `location_required` en vez de elegir uno — aplicar el ajuste al local
 * equivocado toca el Google de otro negocio.
 */
export async function resolveToggleTarget(connectionId?: string): Promise<ToggleTarget> {
  const fail = (body: Record<string, unknown>, status: number): ToggleTarget => ({
    ok: false,
    response: NextResponse.json(body, { status }),
  });

  const session = await getSession();
  if (!session.hasClientAccess) return fail({ error: 'unauthorized' }, 401);

  const resolved = await resolveClientFromSession();
  if (!resolved) return fail({ error: 'unauthorized' }, 401);
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return fail({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, 503);
  }

  const hasAccess = await hasGoogleBusinessConnectAccess(resolved.clientId);
  if (!hasAccess) return fail({ error: 'forbidden' }, 403);

  const connection = await resolveReviewConnection(prisma, resolved.clientId, connectionId);
  if (!connection) {
    return fail({ error: connectionId ? 'not_connected' : 'location_required' }, 404);
  }

  return { ok: true, clientId: resolved.clientId, connectionId: connection.id };
}
