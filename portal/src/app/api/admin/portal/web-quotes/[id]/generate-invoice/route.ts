import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { generateWebQuoteInvoice } from '@/lib/web-quote-invoicing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ERROR_STATUS: Record<string, number> = {
  web_quote_not_found: 404,
  not_accepted: 409,
  no_tenant: 503,
  stripe_customer_create_failed: 503,
  stripe_error: 502,
};

/**
 * POST /api/admin/portal/web-quotes/[id]/generate-invoice
 *
 * El botón de reintento del operador cuando el intento automático (al
 * aceptar el cliente — ver web-quote-invoicing.ts) falló, o cuando un
 * presupuesto viejo se aceptó antes de que ese camino existiera. Requiere
 * un TOTP fresco: es la ruta que un operador con sesión comprometida
 * podría usar para facturar un importe distinto al que el cliente vio —
 * el camino automático no necesita ese paso porque ahí no hay ninguna
 * decisión de importe que proteger, solo la ejecución de una que un
 * operador ya tomó al redactar el presupuesto.
 *
 * La escritura en sí —crear la factura en Stripe, marcar el presupuesto,
 * el correo— vive en generateWebQuoteInvoice (lib/web-quote-invoicing.ts),
 * compartida con ese camino automático.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const result = await generateWebQuoteInvoice(prisma, params.id, { type: 'operator', operatorId: stepUp.operatorId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  }

  return NextResponse.json({ ok: true, webQuote: result.webQuote, invoice: result.invoice });
}
