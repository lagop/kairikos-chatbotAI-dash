import 'server-only';
import type { PrismaClient, WebQuote } from '@prisma/client';

// =============================================================================
// WP-XX — shared read/validation helpers for the 'web' custom-quote
// billing flow. Route handlers stay thin; this is where the "is this
// transition allowed" rules live so they can't drift between routes.
// =============================================================================

/** Statuses a WebQuote can still be edited (amount/description) in. */
export function canEditWebQuote(status: string): boolean {
  return status === 'draft' || status === 'sent';
}

/** Statuses "Enviar al cliente" is allowed from (draft, or re-sending after an edit). */
export function canSendWebQuote(status: string): boolean {
  return status === 'draft' || status === 'sent';
}

/** Statuses the operator can abandon the quote from WITHOUT touching
 *  Stripe. Once an invoice exists, use canVoidInvoice instead — this
 *  never covers invoiced/invoiced_deposit/invoiced_final. */
export function canCancelWebQuote(status: string): boolean {
  return status === 'draft' || status === 'sent' || status === 'accepted';
}

/** Statuses where the CURRENT invoice for this quote might still be
 *  unpaid and voidable (stripe.invoices.voidInvoice). The route additionally
 *  re-checks the actual Invoice.status !== 'paid' before calling Stripe —
 *  this only gates which WebQuote states are even worth trying. Once a
 *  deposit or the full amount is paid (deposit_paid/paid) there is no
 *  cancel path: a refund is a different, more sensitive operation and is
 *  out of scope — see the plan's "fuera de alcance". */
export function canVoidInvoice(status: string): boolean {
  return status === 'invoiced' || status === 'invoiced_deposit' || status === 'invoiced_final';
}

export interface DepositPlan {
  hasDeposit: boolean;
  depositCents: number | null;
  /** The remaining balance once the deposit (if any) is paid. Equals
   *  amountCents when there's no deposit. */
  finalCents: number;
}

/** Splits a WebQuote's amountCents into its deposit/final breakdown.
 *  Pure — reused by both the API routes (to compute what to invoice) and
 *  the operator UI (to preview "Saldo final" while editing a draft). */
export function resolveDepositPlan(webQuote: { amountCents: number; depositCents: number | null }): DepositPlan {
  // Loose check — treats a missing/undefined depositCents (e.g. a select()
  // that forgot the column) the same as an explicit null, rather than
  // silently taking the "has deposit" branch with a garbage amount.
  if (webQuote.depositCents == null) {
    return { hasDeposit: false, depositCents: null, finalCents: webQuote.amountCents };
  }
  return {
    hasDeposit: true,
    depositCents: webQuote.depositCents,
    finalCents: webQuote.amountCents - webQuote.depositCents,
  };
}

export interface WebQuoteContext {
  clientProduct: { id: string; clientId: string; tenantId: string | null; status: string };
  webQuote: WebQuote | null;
}

/** Resolves the client's 'web' ClientProduct + its WebQuote (if any).
 *  Returns null if the client has no 'web' ClientProduct row at all. */
export async function resolveWebQuoteContext(prisma: PrismaClient, clientId: string): Promise<WebQuoteContext | null> {
  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId, product: { code: 'web' } },
    select: { id: true, clientId: true, tenantId: true, status: true },
  });
  if (!clientProduct) return null;
  const webQuote = await prisma.webQuote.findUnique({ where: { clientProductId: clientProduct.id } });
  return { clientProduct, webQuote };
}

export interface WebQuoteQueueRow {
  clientProductId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  webQuote: WebQuote | null;
}

/** Every client currently in the pre-payment 'web' quote flow
 *  (ClientProduct.status='quote_pending'), for the operator's inbox —
 *  this is the read side of the "operator has no visibility into
 *  submitted briefs" gap this whole feature closes. */
export async function listWebQuoteQueue(prisma: PrismaClient): Promise<WebQuoteQueueRow[]> {
  const rows = await prisma.clientProduct.findMany({
    where: { status: 'quote_pending', product: { code: 'web' } },
    orderBy: { changedAt: 'desc' },
    select: {
      id: true,
      clientId: true,
      client: { select: { name: true, email: true } },
      webQuote: true,
    },
  });
  return rows.map((r) => ({
    clientProductId: r.id,
    clientId: r.clientId,
    clientName: r.client.name,
    clientEmail: r.client.email,
    webQuote: r.webQuote,
  }));
}
