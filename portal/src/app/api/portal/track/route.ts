import { NextResponse, type NextRequest } from 'next/server';
import { resolveClientFromSession } from '@/lib/portal-session';
import { trackPageView } from '@/lib/analytics';
import { handleAssetsUploaded } from '@/lib/onboarding-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // Two event shapes flow through this route:
  //   * `page_view` — public page analytics; no session required.
  //   * `assets-uploaded` — KAIA-1062 self-service; client confirms
  //     "I uploaded my assets" on /portal/onboarding. Marks the
  //     assets milestone complete in the activity log.
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
      // The dev-mock branch in handleAssetsUploaded already short-circuits
      // when no DB is configured, so the same handler covers both.
      return handleAssetsUploaded(resolved.clientId, { milestone, notes });
    }
    return handleAssetsUploaded(resolved.clientId, { milestone, notes });
  }

  return NextResponse.json({ ok: true, ignored: true });
}
