import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { startDepositCheckout } from '@/lib/villas/requests';
import { guestRequestUrl } from '@/lib/villas/emails';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/public/villas/solicitud/[guestToken]/checkout — el botón «Pagar
 * el depósito» de la página del huésped (/reserva-villa/<token>).
 *
 * Un <form> normal, sin JavaScript: responde 303 a la página de Stripe
 * Checkout, o de vuelta a la página del huésped con ?pago=<error>. Solo se
 * puede pagar una solicitud ACEPTADA y dentro de plazo; el importe sale de la
 * solicitud guardada, nunca del formulario.
 */
const limiter = new InMemoryRateLimiter(60 * 1000);

export async function POST(_req: NextRequest, props: { params: Promise<{ guestToken: string }> }) {
  const { guestToken } = await props.params;
  const back = (code: string) => NextResponse.redirect(`${guestRequestUrl(guestToken)}?pago=${code}`, 303);
  if (!limiter.check(`villa-checkout:${guestToken}`, 10)) return back('espera');
  if (!isDatabaseConfigured) return back('error');

  const result = await startDepositCheckout(prisma, { guestToken });
  if (result.ok) return NextResponse.redirect(result.url, 303);
  if (result.error === 'not_found') return new NextResponse('Not found', { status: 404 });
  if (result.error === 'already_paid') return back('ok');
  if (result.error === 'not_payable') return back('fuera-de-plazo');
  return back('error');
}
