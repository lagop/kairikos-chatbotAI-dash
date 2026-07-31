import { NextResponse, type NextRequest } from 'next/server';
import { resolveClientFromSession } from '@/lib/portal-session';
import { trackPageView, trackOnboardingEvent } from '@/lib/analytics';
import { handleAssetsUploaded } from '@/lib/onboarding-actions';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_FUNNEL_EVENTS: ReadonlySet<string> = new Set([
  'step_seen',
  'step_completed',
  'signup',
  'product_selected',
  'config_saved',
  'checkout_started',
  'activated',
  'abandoned',
]);

export async function POST(req: NextRequest) {
  // Three event shapes flow through this route:
  //   * `page_view` — public page analytics; no session required.
  //   * `assets-uploaded` — KAIA-1062 self-service; client confirms
  //     "I uploaded my assets" on /portal/onboarding.
  //   * `onboarding_event` — KAIA-4263 self-serve wizard funnel
  //     event. Anonymous, no session required.
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (body?.type === 'page_view') {
    if (typeof body.path === 'string') {
      await trackPageView({
        path: body.path,
        referrer: (body.referrer as string | null | undefined) ?? null,
        title: (body.title as string | null | undefined) ?? null,
        locale: 'es',
        userId: null,
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (body?.type === 'onboarding_event') {
    const event = typeof body.event === 'string' ? body.event : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!ALLOWED_FUNNEL_EVENTS.has(event) || sessionId.length < 8) {
      return NextResponse.json({ ok: true, ignored: true });
    }
    const path = typeof body.path === 'string' ? body.path : '/onboarding';
    const step = typeof body.step === 'string' ? body.step : null;
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const ts = typeof body.ts === 'string' ? body.ts : new Date().toISOString();
    await trackOnboardingEvent({
      event: event as Parameters<typeof trackOnboardingEvent>[0]['event'],
      step: step ?? undefined,
      reason: reason ?? undefined,
      sessionId,
      path,
      ts,
    });
    if (isDatabaseConfigured) {
      try {
        await prisma.onboardingFunnelEvent.create({
          data: {
            event,
            sessionToken: sessionId,
            step,
            reason,
            path,
            ts: new Date(ts),
          },
        });
      } catch {
        // analytics must never 500 the wizard
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (body?.event === 'assets-uploaded') {
    const resolved = await resolveClientFromSession();
    if (!resolved) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const milestone =
      typeof body.milestone === 'string' && body.milestone.length > 0
        ? body.milestone
        : undefined;
    const notes =
      typeof body.notes === 'string' && body.notes.length > 0
        ? body.notes
        : undefined;
    if (resolved.source === 'mock_dev') {
      return handleAssetsUploaded(resolved.clientId, { milestone, notes });
    }
    return handleAssetsUploaded(resolved.clientId, { milestone, notes });
  }

  return NextResponse.json({ ok: true, ignored: true });
}

