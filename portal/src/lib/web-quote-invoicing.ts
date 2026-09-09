import 'server-only';
import type { PrismaClient, WebQuote, Invoice } from '@prisma/client';
import { ensureCustomerForTenant, createWebQuoteInvoice, syncInvoiceFromStripe } from './stripe-billing';
import { resolveDepositPlan } from './web-quotes';
import { sendWebQuoteInvoiceEmail } from './web-quote-email';
import { logError } from './observability';

// =============================================================================
// Fase 6 — la escritura compartida de "generar la factura".
//
// Extraída de POST .../generate-invoice cuando apareció un SEGUNDO
// llamante: la aceptación del cliente. "Genera la factura" es el paso
// que 'Cadena de entrega por producto' marcó automatizable — "un
// presupuesto aceptado puede llevar a una sesión de pago y facturarse
// solo" — y el precio ya no lo decide nadie en este momento: lo fijó un
// operador al redactar el presupuesto (canEditWebQuote ya bloquea editar
// el importe en cuanto el estado deja de ser draft/sent), y el cliente
// solo puede aceptar EXACTAMENTE lo que se le envió. Por eso el paso de
// TOTP del operador —pensado para proteger una sesión de operador
// comprometida creando facturas arbitrarias— no aplica aquí: no hay
// decisión de importe que proteger, solo la ejecución de una que ya se
// tomó y se comunicó.
//
// El propio comentario de /api/portal/web-quote/accept decía "per the
// confirmed design, acceptance does NOT auto-invoice" — una decisión
// consciente, no un descuido. Se revisa aquí a la luz de ese análisis:
// el resto de productos self-serve tampoco piden un paso de operador
// para cobrar un precio que un operador ya fijó de antemano en el
// catálogo, así que 'web' quedándose atrás en esto era la excepción, no
// la norma.
// =============================================================================

export type GenerateWebQuoteInvoiceActor = { type: 'operator'; operatorId: string } | { type: 'system'; source: string };

export type GenerateWebQuoteInvoiceResult =
  | { ok: true; webQuote: WebQuote; invoice: Invoice | null }
  | {
      ok: false;
      error: 'web_quote_not_found' | 'not_accepted' | 'no_tenant' | 'stripe_customer_create_failed' | 'stripe_error';
    };

/**
 * Genera (o reintenta generar) la factura de un presupuesto ya aceptado.
 * Único punto de escritura para ambos llamantes — la ruta del operador y
 * el disparador automático al aceptar — así que el comportamiento nunca
 * puede divergir entre los dos.
 *
 * Nunca deja el presupuesto a medias: si Stripe falla, el estado se
 * queda en 'accepted' exactamente como estaba, listo para que CUALQUIERA
 * de los dos caminos lo reintente — el automático en el siguiente intento
 * del cliente (no hay uno hoy, ver la ruta de accept) o el operador desde
 * el panel, sin que haga falta ningún mecanismo de reintento nuevo.
 */
export async function generateWebQuoteInvoice(
  prisma: PrismaClient,
  webQuoteId: string,
  actor: GenerateWebQuoteInvoiceActor,
): Promise<GenerateWebQuoteInvoiceResult> {
  const webQuote = await prisma.webQuote.findUnique({ where: { id: webQuoteId } });
  if (!webQuote) return { ok: false, error: 'web_quote_not_found' };
  if (webQuote.status !== 'accepted') return { ok: false, error: 'not_accepted' };

  const clientProduct = await prisma.clientProduct.findUnique({
    where: { id: webQuote.clientProductId },
    select: { id: true, tenantId: true },
  });
  if (!clientProduct || !clientProduct.tenantId) return { ok: false, error: 'no_tenant' };

  const stripeCustomerId = await ensureCustomerForTenant(clientProduct.tenantId);
  if (!stripeCustomerId) return { ok: false, error: 'stripe_customer_create_failed' };

  const plan = resolveDepositPlan(webQuote);
  const role: 'full' | 'deposit' = plan.hasDeposit ? 'deposit' : 'full';
  const invoiceAmountCents = plan.hasDeposit ? plan.depositCents! : webQuote.amountCents;
  const nextStatus = plan.hasDeposit ? 'invoiced_deposit' : 'invoiced';

  let stripeInvoiceId: string;
  try {
    const invoice = await createWebQuoteInvoice({
      stripeCustomerId,
      amountCents: invoiceAmountCents,
      currency: webQuote.currency,
      description: plan.hasDeposit ? `${webQuote.description} — adelanto` : webQuote.description,
      metadata: {
        kairikos_tenant_id: clientProduct.tenantId,
        kairikos_client_id: webQuote.clientId,
        kairikos_client_product_id: clientProduct.id,
        kairikos_web_quote_id: webQuote.id,
        kairikos_product_code: 'web',
        kairikos_invoice_role: role,
      },
    });
    // Se persiste el espejo del Invoice de forma síncrona (mismo patrón
    // que la ruta de checkout de operador) para que quien lea el
    // resultado tenga hostInvoiceUrl ya mismo, sin esperar al webhook
    // invoice.created.
    await syncInvoiceFromStripe(invoice);
    stripeInvoiceId = invoice.id ?? '';
  } catch (err) {
    logError('web_quote_invoicing.stripe_call_failed', err, { webQuoteId: webQuote.id, actorType: actor.type }, 'warn');
    return { ok: false, error: 'stripe_error' };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.webQuote.update({ where: { id: webQuote.id }, data: { status: nextStatus } });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: row.id,
        action: nextStatus,
        before: { status: 'accepted' },
        after: { status: nextStatus, stripeInvoiceId },
        actorType: actor.type,
        actorOperatorId: actor.type === 'operator' ? actor.operatorId : null,
        actorEmail: actor.type === 'system' ? `system:${actor.source}` : null,
      },
    });
    return row;
  });

  const localInvoice = await prisma.invoice.findUnique({ where: { stripeId: stripeInvoiceId } });

  // Mejor esfuerzo — un fallo de correo nunca bloquea la respuesta: la
  // factura ya existe de verdad en Stripe, que es lo que importa.
  const client = await prisma.chatbotClient.findUnique({
    where: { id: updated.clientId },
    select: { email: true, companyName: true, name: true },
  });
  if (client) {
    const emailResult = await sendWebQuoteInvoiceEmail({
      to: client.email,
      businessName: client.companyName ?? client.name,
      amountCents: invoiceAmountCents,
      currency: updated.currency,
      role,
      hostInvoiceUrl: localInvoice?.hostInvoiceUrl ?? null,
    });
    if (!emailResult.ok) {
      logError('web_quote_invoicing.email_failed', new Error(emailResult.error), { webQuoteId: updated.id }, 'warn');
    }
  }

  return { ok: true, webQuote: updated, invoice: localInvoice };
}
