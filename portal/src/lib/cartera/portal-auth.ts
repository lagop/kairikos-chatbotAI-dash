import 'server-only';
import { NextResponse } from 'next/server';
import type { CarteraSite } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { findSiteForClient, findSiteForOwner } from './site';

// =============================================================================
// Cartera — quién puede tocar el panel, como lib/villas/portal-auth.ts.
//
// El cliente sale SIEMPRE de la sesión, nunca del cuerpo; y el CarteraSite, de
// ese cliente. Cada ruta comprueba además que la casa o la foto cuelga de ESTE
// sitio, así que un id ajeno en la URL da 404.
//
// Dos modos:
//   - 'read':  también en el plazo de gracia de una baja o con la
//              contratación suspendida (findSiteForOwner): la agencia tiene
//              que poder ver y llevarse sus datos.
//   - 'write': solo activa o en pausa (findSiteForClient). En la gracia de la
//              baja el panel es de solo lectura: 403 'read_only'.
// =============================================================================

export type CarteraPortalContext =
  | { ok: true; clientId: string; actor: string; site: CarteraSite; readOnly: boolean }
  | { ok: false; response: NextResponse };

export async function requireCarteraPortal(mode: 'read' | 'write'): Promise<CarteraPortalContext> {
  const session = await getSession();
  if (!session.hasClientAccess) return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  if (!isDatabaseConfigured) return { ok: false, response: NextResponse.json({ error: 'service_unavailable' }, { status: 503 }) };
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  const actor = `client:${resolved.clientId}`;

  const writable = await findSiteForClient(prisma, resolved.clientId);
  if (writable) return { ok: true, clientId: resolved.clientId, actor, site: writable, readOnly: false };

  const owner = await findSiteForOwner(prisma, resolved.clientId);
  if (!owner) return { ok: false, response: NextResponse.json({ error: 'not_contracted' }, { status: 403 }) };
  if (mode === 'write') return { ok: false, response: NextResponse.json({ error: 'read_only' }, { status: 403 }) };
  const { clientProduct: _contract, ...site } = owner.site;
  return { ok: true, clientId: resolved.clientId, actor, site, readOnly: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
