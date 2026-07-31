import { NextResponse, type NextRequest } from 'next/server';
import { ActivateSchema } from '@/lib/onboarding/schemas';
import {
  getOnboardingSession,
  markActivated,
} from '@/lib/onboarding/sessions';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/onboarding/activate — KAIA-4263
//
// Idempotent confirmation of a paid onboarding. Body matches the
// ActivateSchema.
//
// Behaviour:
//   1. Resolve the OnboardingSession; 404 if unknown.
//   2. Confirm payment actually settled before flipping status to
//      `active`:
//        - If we have a stripeSessionId, prefer Stripe as the source
//          of truth (the Stripe webhook is the canonical writer).
//        - Otherwise fall back to the ClientProduct row the wizard
//          pre-created during checkout.
//   3. Once confirmed, mark the session `active` and return the
//      activation timestamp so the React wizard can compute
//      time-to-active.
//   4. The frontend component polls this endpoint only when it does
//      NOT have a stripeSessionId (e.g. the URL has no
//      `?session_id=` — the Stripe Checkout success URL DOES carry
//      that id).
//
// Authoritative activation is the Stripe webhook's job; this route
// exists so the React component has a deterministic confirmation
// path when Stripe callbacks lag.
//
// Responses:
//   200 { activated: true, activatedAt }
//   200 { activated: false, status: 'pending_payment' }
//   400 { error: 'invalid_body', details }
//   404 { error: 'session_not_found' }
//   503 { error: 'service_unavailable', detail }
// =============================================================================

interface StripeSessionLike {
  status: string;
  payment_status?: string;
  metadata?: Record<string, string>;
}

async function lookupStripeSessionStatus(
  sessionId: string,
): Promise<StripeSessionLike | null> {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const { getStripe } = await import('@/lib/stripe');
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      status: session.status ?? 'unknown',
      payment_status: session.payment_status ?? undefined,
      metadata: (session.metadata ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = ActivateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const session = await getOnboardingSession(parsed.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }

  if (parsed.data.stripeSessionId) {
    const stripe = await lookupStripeSessionStatus(parsed.data.stripeSessionId);
    if (stripe && stripe.status !== 'complete' && stripe.payment_status !== 'paid') {
      return NextResponse.json(
        { activated: false, status: 'pending_payment' },
        { status: 200 },
      );
    }
  }

  const clientProductId = parsed.data.clientProductId ?? session.clientProductId;
  if (isDatabaseConfigured && clientProductId) {
    try {
      const cp = await prisma.clientProduct.findUnique({
        where: { id: clientProductId },
        select: { status: true },
      });
      if (cp && cp.status !== 'active') {
        return NextResponse.json(
          { activated: false, status: 'pending_payment' },
          { status: 200 },
        );
      }
    } catch {
      // fall through — the session row is still authoritative for
      // `activatedAt`.
    }
  }

  const activatedAt = new Date();
  await markActivated(parsed.data.sessionId, activatedAt);
  return NextResponse.json({ activated: true, activatedAt: activatedAt.toISOString() });
}
