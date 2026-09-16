import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from './prisma';
import {
  setOwnerWhatsapp,
  setGreeting,
  clearGreeting,
  readGreeting,
  MAX_GREETING_BYTES,
  type RecallSettingsActor,
} from './recall-owner-settings';
import { logError } from './observability';

// =============================================================================
// El lado HTTP de recall-owner-settings.ts, compartido por las rutas del
// cliente (/api/portal/recall/…) y las del operador
// (/api/admin/portal/recall/[subscriptionId]/…). Cada ruta solo resuelve
// QUÉ suscripción y QUIÉN actúa; lo demás es idéntico y vive aquí para que
// las dos no diverjan.
// =============================================================================

export interface SettingsTarget {
  subscriptionId: string;
  actor: RecallSettingsActor;
}

const VALIDATION_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_number: 400,
  not_mobile: 400,
  same_as_business: 400,
  empty: 400,
  too_large: 413,
  unsupported_format: 415,
  corrupt_wav: 400,
  too_short: 400,
  too_long: 400,
};

const OwnerBody = z.object({ ownerWhatsapp: z.string().min(1).max(40) });

export async function handleOwnerWhatsappPatch(req: NextRequest, target: SettingsTarget): Promise<Response> {
  const body = OwnerBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  try {
    const result = await setOwnerWhatsapp(prisma, { ...target, raw: body.data.ownerWhatsapp });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: VALIDATION_STATUS[result.error] ?? 400 });
    return NextResponse.json(result);
  } catch (err) {
    logError('recall_owner_settings.owner_patch_failed', err, { subscriptionId: target.subscriptionId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function handleGreetingPut(req: NextRequest, target: SettingsTarget): Promise<Response> {
  // Se corta antes de leer el cuerpo cuando la cabecera ya lo delata; el
  // tope real se vuelve a comprobar sobre los bytes, que la cabecera la
  // pone quien envía.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_GREETING_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 });

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  try {
    const result = await setGreeting(prisma, { ...target, bytes });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: VALIDATION_STATUS[result.error] ?? 400 });
    return NextResponse.json(result);
  } catch (err) {
    logError('recall_owner_settings.greeting_put_failed', err, { subscriptionId: target.subscriptionId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function handleGreetingDelete(target: SettingsTarget): Promise<Response> {
  const result = await clearGreeting(prisma, target);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function handleGreetingGet(target: SettingsTarget): Promise<Response> {
  const audio = await readGreeting(prisma, target);
  if (!audio) return new Response('not_found', { status: 404 });
  return new Response(Buffer.from(audio.bytes), {
    status: 200,
    headers: {
      'content-type': audio.mimeType,
      'content-length': String(audio.bytes.length),
      // Es la voz del dueño detrás de una sesión: que no la guarde nadie
      // por el camino, y que tras regrabar se oiga la nueva.
      'cache-control': 'private, no-store',
    },
  });
}
