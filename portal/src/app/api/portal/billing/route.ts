import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { MOCK_BILLING_EXPORT as MOCK_BILLING } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIER_PRICE_CENTS: Record<string, number> = {
  starter: 9900,
  pro: 24900,
  premium: 49900,
};

const TIER_LABEL: Record<string, string> = {
  starter: 'Web Starter',
  pro: 'Web Pro',
  premium: 'Web Premium',
};

export async function GET(_req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json(MOCK_BILLING);
  }
  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tier: true, stripeCustomerId: true },
  });
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const tier = client.tier in TIER_PRICE_CENTS ? client.tier : 'starter';
  const monthlyFeeCents = TIER_PRICE_CENTS[tier];
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return NextResponse.json({
    tier,
    tierLabel: TIER_LABEL[tier],
    monthlyFeeCents,
    currency: 'EUR',
    nextInvoiceDate: next.toISOString(),
    nextInvoiceAmountCents: monthlyFeeCents,
    stripeCustomerPortalUrl: client.stripeCustomerId
      ? `https://billing.stripe.com/p/session/${client.stripeCustomerId}`
      : null,
    stripeCustomerId: client.stripeCustomerId,
  });
}
