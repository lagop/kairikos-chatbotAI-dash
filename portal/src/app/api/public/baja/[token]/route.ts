import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { unsubscribeByToken } from '@/lib/inbound-follow-up';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 25/10/2026 — la baja de un clic de los correos de seguimiento
// (lib/inbound-follow-up.ts). Art. 21 LSSI: darse de baja tiene que ser
// sencillo y gratuito, y funcionar.
//
// GET es el enlace del pie del correo: un clic y hecho, sin formulario. Que
// un GET cambie algo es deliberado: si el escáner de enlaces de un antivirus
// lo abre por su cuenta, lo peor que pasa es que dejamos de escribir a alguien
// que no se había dado de baja — el error en la dirección segura.
//
// POST es la baja de un clic de RFC 8058 (cabecera List-Unsubscribe-Post),
// la que lanza el propio Gmail con su botón «Cancelar suscripción».
//
// Siempre la misma respuesta, exista o no el testigo: la página no confirma a
// nadie qué testigos son válidos.
// =============================================================================

const PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Baja hecha · Kairikos</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f7f5ef;color:#1d1d1b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}main{max-width:440px;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;margin:0 0 10px}a{color:#0e6b5e}</style>
</head><body><main>
<h1>Listo: no te volvemos a escribir</h1>
<p>Te hemos dado de baja de los correos de Kairikos sobre tu borrador de web o tu cálculo de llamadas.</p>
<p>Si ha sido sin querer o quieres retomarlo, escríbenos a <a href="mailto:contacto@kairikos.com">contacto@kairikos.com</a>.</p>
<p><a href="https://kairikos.com/">kairikos.com</a></p>
</main></body></html>`;

async function handle(token: string): Promise<void> {
  if (!isDatabaseConfigured) return;
  try {
    await unsubscribeByToken(prisma, token);
  } catch (err) {
    logError('inbound_follow_up.unsubscribe_failed', err, { route: 'api/public/baja' }, 'error');
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  await handle(token);
  return new NextResponse(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function POST(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  await handle(token);
  return NextResponse.json({ ok: true });
}
