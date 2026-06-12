import { NextResponse, type NextRequest } from 'next/server';
import { resolveClientFromSession } from '@/lib/portal-session';
import { handleGoLiveReady } from '@/lib/onboarding-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return handleGoLiveReady(resolved.clientId, {});
}
