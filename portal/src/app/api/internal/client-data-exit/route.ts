import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { isExitProduct, loadExit, notifyExit, purgeExit, type ExitActionResult } from '@/lib/client-data-exit';
import { resolveActiveTwilioCredentials } from '@/lib/twilio-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// =============================================================================
// POST /api/internal/client-data-exit — la baja de los datos de un cliente en
// el chat, las llamadas o las solicitudes (lib/client-data-exit.ts, PR 5a del
// plan del encargo). La llama el operador con scripts/baja-datos-cliente.sh,
// desde el contenedor del scheduler; el scheduler NO la llama: no es un cron.
//
// Va con CRON_SECRET, como las rutas de cron, porque es lo que ya tiene el
// contenedor que la llama y porque no amplía lo que ese secreto permite
// borrar: solo actúa sobre contrataciones dadas de baja y fuera de plazo, lo
// mismo que borrarán solos villas, cartera y (PR 5b) esto mismo.
//
// Cuerpo: { clientId, product: 'chatbot'|'recall'|'leads',
//           action: 'estado'|'avisar'|'borrar', confirm?: true,
//           operator: '<quién>' (obligatorio para avisar y borrar) }
// =============================================================================

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPERATOR = /^[A-Za-z0-9._@+-]{2,120}$/;

function statusFor(result: ExitActionResult): number {
  if (result.ok) return 200;
  if (result.error === 'client_not_found') return 404;
  if (result.error === 'email_failed' || result.error === 'twilio_failed') return 502;
  return 409;
}

export async function POST(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = body?.clientId;
  const product = body?.product;
  const action = body?.action;
  const operator = body?.operator;
  if (typeof clientId !== 'string' || !ID.test(clientId) || !isExitProduct(product)) {
    return NextResponse.json({ error: 'bad_request', detail: 'clientId o product' }, { status: 400 });
  }
  if (action !== 'estado' && action !== 'avisar' && action !== 'borrar') {
    return NextResponse.json({ error: 'bad_request', detail: 'action: estado | avisar | borrar' }, { status: 400 });
  }
  if (action !== 'estado' && (typeof operator !== 'string' || !OPERATOR.test(operator))) {
    return NextResponse.json({ error: 'bad_request', detail: 'operator' }, { status: 400 });
  }

  const now = new Date();
  try {
    if (action === 'estado') {
      const { client, status } = await loadExit(prisma, clientId, product, now);
      return NextResponse.json({ ok: client !== null, status }, { status: client ? 200 : 404 });
    }
    const result =
      action === 'avisar'
        ? await notifyExit(prisma, clientId, product, operator as string, now)
        : await purgeExit(prisma, clientId, product, operator as string, body?.confirm === true, now, {
            twilioAuth: resolveActiveTwilioCredentials,
          });
    return NextResponse.json(result, { status: statusFor(result) });
  } catch (err) {
    logError('client_data_exit.failed', err, { clientId, product, action }, 'error');
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, { status: 500 });
  }
}
