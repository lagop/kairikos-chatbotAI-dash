import { NextResponse } from 'next/server';
import { trackPageView } from '@/lib/analytics';

export async function POST(req: Request) {
  try {
    const event = (await req.json()) as {
      type?: string;
      path?: string;
      referrer?: string | null;
      title?: string | null;
    };
    if (event?.type === 'page_view' && typeof event.path === 'string') {
      await trackPageView({
        path: event.path,
        referrer: event.referrer ?? null,
        title: event.title ?? null,
        locale: 'es',
        userId: null,
      });
    }
  } catch {
    // ignore
  }
  return NextResponse.json({ ok: true });
}
