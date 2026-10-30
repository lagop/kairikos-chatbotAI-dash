import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { servePublicDraftPreview } from '@/lib/public-draft-editor';
import { parsePreviewOverride } from '@/lib/website-preview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 30/10/2026 — POST: la vista en vivo del editor, con lo escrito sin guardar.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const override = parsePreviewOverride(await req.json().catch(() => null));
  if (!override) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  return servePublicDraftPreview(prisma, params.id, override);
}
