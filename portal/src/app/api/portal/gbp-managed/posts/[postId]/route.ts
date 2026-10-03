import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { editDraft, publishDraft, rejectDraft } from '@/lib/gbp-managed';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/portal/gbp-managed/posts/[postId]
 *   body: { action: 'edit', summary } | { action: 'publish' } | { action: 'reject' }
 *
 * Plan de precios del 01/10/2026 — el veto del cliente sobre la publicación
 * semanal de su ficha. Editar NO publica (solo cambia lo que saldrá);
 * publicar adelanta el plazo; descartar la retira. Todo, solo sobre un
 * borrador del propio cliente: el id de la URL se cruza con su clientId.
 */
const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), summary: z.string().trim().min(40).max(1500) }),
  z.object({ action: z.literal('publish') }),
  z.object({ action: z.literal('reject') }),
]);

export async function PATCH(req: NextRequest, props: { params: Promise<{ postId: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const post = await prisma.gbpPost.findFirst({
    where: { id: params.postId, clientId: resolved.clientId },
    select: { id: true },
  });
  if (!post) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (body.data.action === 'edit') {
    const res = await editDraft(prisma, { postId: post.id, clientId: resolved.clientId, summary: body.data.summary });
    if (res === 'not_found') return NextResponse.json({ error: 'not_editable' }, { status: 409 });
    // 'risky': se guarda, pero no saldrá sola hasta quitar lo que la retiene.
    return NextResponse.json({ ok: true, held: res === 'risky' });
  }
  if (body.data.action === 'reject') {
    const ok = await rejectDraft(prisma, { postId: post.id, clientId: resolved.clientId });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_editable' }, { status: 409 });
  }
  const outcome = await publishDraft(prisma, post.id, `client:${resolved.clientId}`);
  if (outcome === 'published') return NextResponse.json({ ok: true });
  if (outcome === 'publish_failed') return NextResponse.json({ error: 'publish_failed' }, { status: 502 });
  return NextResponse.json({ error: 'not_publishable' }, { status: 409 });
}
