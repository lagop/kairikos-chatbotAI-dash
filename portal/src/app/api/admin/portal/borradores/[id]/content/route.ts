import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { savePublicDraftContent } from '@/lib/public-draft-editor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 30/10/2026 — PATCH: el operador guarda el borrador de una petición de
// kairikos.com desde el editor de webs (lib/public-draft-editor.ts).
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const result = await savePublicDraftContent(prisma, params.id, await req.json().catch(() => null));
  return NextResponse.json(result.body, { status: result.status });
}
