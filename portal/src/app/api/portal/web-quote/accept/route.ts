import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { resolveWebQuoteContext } from '@/lib/web-quotes';
import { generateWebQuoteInvoice } from '@/lib/web-quote-invoicing';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ clientProductId: z.string().uuid() });

/**
 * POST /api/portal/web-quote/accept
 *
 * El clic de aceptación del cliente. La aceptación en sí (esta
 * transacción) queda separada del intento de facturar — si Stripe falla
 * o tarda, el clic del cliente igualmente tiene que quedar registrado.
 *
 * Fase 6 — "genera la factura" era, hasta aquí, un paso aparte que
 * exigía a un operador (POST .../generate-invoice, con un TOTP fresco).
 * Ese TOTP protege a un operador con sesión comprometida de facturar un
 * importe que el cliente no vio; aquí no hace falta, porque no hay
 * ninguna decisión de importe que tomar — el presupuesto ya lo fijó un
 * operador al redactarlo y enviarlo, y el cliente solo puede aceptar
 * EXACTAMENTE eso (canEditWebQuote ya bloquea editar el importe en
 * cuanto deja de estar en borrador/enviado). Es la misma razón por la
 * que el resto de productos self-serve tampoco piden a un operador que
 * confirme cobrar un precio de catálogo que un operador ya fijó de
 * antemano.
 *
 * Se llama a generateWebQuoteInvoice DESPUÉS de que la aceptación ya
 * esté confirmada en la base de datos, no dentro de la misma transacción
 * — una llamada a Stripe no pertenece dentro de una transacción de
 * Prisma, y un fallo de Stripe (caído, lento) no puede impedir que la
 * aceptación del cliente quede registrada. Si falla, el presupuesto
 * simplemente se queda en 'accepted' — exactamente el estado en el que
 * ya vivía este flujo antes de la Fase 6 — y un operador puede
 * completarlo a mano desde el panel (POST .../generate-invoice) sin que
 * haga falta ningún mecanismo de reintento nuevo.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const context = await resolveWebQuoteContext(prisma, body.data.clientProductId);
  if (!context || context.clientProduct.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  }
  if (!context.webQuote) {
    return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });
  }
  const { webQuote } = context;
  if (webQuote.status !== 'sent') {
    return NextResponse.json({ error: 'not_sent' }, { status: 409 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({
      where: { id: webQuote.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: 'accepted',
        before: { status: 'sent' },
        after: { status: 'accepted' },
        actorType: 'client',
        actorEmail: `client:${resolved.clientId}`,
      },
    });
    return row;
  });

  const invoiceResult = await generateWebQuoteInvoice(prisma, updated.id, {
    type: 'system',
    source: 'web_quote_accepted',
  });
  if (!invoiceResult.ok) {
    // No es un error para el cliente: su aceptación ya quedó registrada.
    // Un operador ve el presupuesto en 'accepted' sin factura y puede
    // completarlo a mano — el mismo camino que existía antes de esto.
    logError('web_quote_accept.auto_invoice_failed', new Error(invoiceResult.error), { webQuoteId: updated.id }, 'warn');
    return NextResponse.json({ ok: true, webQuote: updated });
  }

  return NextResponse.json({ ok: true, webQuote: invoiceResult.webQuote, invoice: invoiceResult.invoice });
}
