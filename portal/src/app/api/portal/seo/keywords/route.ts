import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { normalizeKeyword, MAX_TARGET_KEYWORDS } from '@/lib/seo-keywords';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 3.1 — PUT /api/portal/seo/keywords
//
// El cliente declara por qué palabras quiere posicionar. Se manda la lista
// COMPLETA, no altas y bajas sueltas: es una lista corta que se edita
// entera en la propia tarjeta, y así no hay estados intermedios raros si
// dos pestañas guardan a la vez.
//
// Quitar una palabra borra también su histórico (onDelete: Cascade en el
// esquema): guardar posiciones de algo que ya no se persigue solo ensucia.
// =============================================================================

const BodySchema = z.object({
  keywords: z.array(z.string().trim().min(2).max(120)).max(MAX_TARGET_KEYWORDS),
});

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  // Las palabras cuelgan del perfil de SEO: sin perfil no hay producto que
  // configurar todavía.
  const profile = await prisma.seoProfile.findFirst({
    where: { clientId: resolved.clientId, clientProduct: { status: 'active' } },
    select: { id: true, tenantId: true },
  });
  if (!profile) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Normalizadas y sin duplicados: "Mechas " y "mechas" son la misma.
  const desired = Array.from(new Set(body.data.keywords.map(normalizeKeyword).filter((k) => k.length >= 2)));

  try {
    const existing = await prisma.seoTargetKeyword.findMany({
      where: { profileId: profile.id },
      select: { id: true, keyword: true },
    });
    const existingByKeyword = new Map(existing.map((k) => [k.keyword, k]));

    const toDelete = existing.filter((k) => !desired.includes(k.keyword)).map((k) => k.id);
    const toCreate = desired.filter((k) => !existingByKeyword.has(k));

    await prisma.$transaction([
      ...(toDelete.length > 0
        ? [prisma.seoTargetKeyword.deleteMany({ where: { id: { in: toDelete } } })]
        : []),
      ...(toCreate.length > 0
        ? [
            prisma.seoTargetKeyword.createMany({
              data: toCreate.map((keyword) => ({
                profileId: profile.id,
                clientId: resolved.clientId,
                tenantId: profile.tenantId,
                keyword,
              })),
            }),
          ]
        : []),
    ]);

    return NextResponse.json({ ok: true, keywords: desired, added: toCreate.length, removed: toDelete.length });
  } catch (err) {
    logError('seo_keywords.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
