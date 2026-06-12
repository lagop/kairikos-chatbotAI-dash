import { NextResponse, type NextRequest } from 'next/server';
import { resolveClientFromSession } from '@/lib/portal-session';
import { handleSnooze } from '@/lib/onboarding-actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SnoozeBody {
  milestoneId?: unknown;
  days?: unknown;
}

export async function POST(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: SnoozeBody = {};
  try {
    body = (await req.json()) as SnoozeBody;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }
  const milestoneId =
    typeof body.milestoneId === 'string' ? body.milestoneId : '';
  const days = typeof body.days === 'number' ? body.days : 1;
  return handleSnooze(resolved.clientId, { milestoneId, days });
}
