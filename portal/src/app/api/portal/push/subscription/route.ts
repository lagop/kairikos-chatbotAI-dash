import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isPushConfigured, vapidPublicKey } from '@/lib/push-notifications';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 5d — /api/portal/push/subscription
//
//   GET     la clave pública VAPID y si push está disponible
//   POST    guarda la suscripción de ESTE dispositivo
//   DELETE  la borra
//
// EL CLIENTE SALE DE LA SESIÓN, como en todas las rutas del portal. Una
// suscripción guardada con un clientId ajeno haría que los avisos de las
// llamadas de otro negocio aparecieran en este móvil.
//
// EL ENDPOINT SE VALIDA COMO HTTPS. Es una URL que luego el servidor va a
// llamar con un POST; aceptar cualquier cadena convertiría esta ruta en un
// modo de hacer que el portal golpee direcciones arbitrarias (incluidas
// internas). Todos los servicios push reales son https.
// =============================================================================

const SubscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://'), { message: 'endpoint_must_be_https' }),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
});

const UnsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

async function resolveContext() {
  const session = await getSession();
  if (!session.hasClientAccess || !session.email) return { error: 'unauthorized' as const, status: 401 };
  if (!isDatabaseConfigured) return { error: 'service_unavailable' as const, status: 503 };
  const resolved = await resolveClientFromSession();
  if (!resolved?.clientId) return { error: 'forbidden' as const, status: 403 };
  return { session, clientId: resolved.clientId };
}

export async function GET() {
  const ctx = await resolveContext();
  if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  return NextResponse.json({ available: isPushConfigured(), publicKey: vapidPublicKey() });
}

export async function POST(req: NextRequest) {
  const ctx = await resolveContext();
  if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  if (!isPushConfigured()) return NextResponse.json({ error: 'push_not_configured' }, { status: 503 });

  const body = SubscribeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  try {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: ctx.clientId },
      select: { tenantId: true },
    });

    await prisma.pushSubscription.upsert({
      where: { endpoint: body.data.endpoint },
      create: {
        clientId: ctx.clientId,
        tenantId: client?.tenantId ?? null,
        userEmail: ctx.session.email!,
        endpoint: body.data.endpoint,
        p256dh: body.data.keys.p256dh,
        auth: body.data.keys.auth,
        userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
      },
      // Si el mismo dispositivo lo usa ahora otra persona de otro negocio
      // —un móvil de empresa que cambia de manos—, la suscripción pasa a la
      // sesión actual. Dejarla con el cliente anterior mandaría a este
      // móvil los avisos de un negocio que ya no es el suyo.
      update: {
        clientId: ctx.clientId,
        tenantId: client?.tenantId ?? null,
        userEmail: ctx.session.email!,
        p256dh: body.data.keys.p256dh,
        auth: body.data.keys.auth,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('push.subscribe_failed', err, { clientId: ctx.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const ctx = await resolveContext();
  if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const body = UnsubscribeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  // Filtrado también por cliente: sin eso, conocer el endpoint de otro
  // dispositivo bastaría para silenciarlo.
  await prisma.pushSubscription.deleteMany({
    where: { endpoint: body.data.endpoint, clientId: ctx.clientId },
  });
  return NextResponse.json({ ok: true });
}
