import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isUuid, requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { findOwnedHome } from '@/lib/cartera/homes';
import { InMemoryRateLimiter } from '@/lib/operator-crypto';
import { TRANSLATIONS_PER_HOUR, isEmptyTranslationInput, translateHomeTexts } from '@/lib/cartera-translation-ai';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/cartera/casas/[id]/traducir
 *   body: { title, summary, floor, lacks: [...], alts: [{ id, text }] }   (en español)
 *
 * Cartera — «Traducir con IA» (decisión B). Propone el inglés y el alemán de
 * los textos que la agente tiene en pantalla, guardados o no. NO GUARDA nada:
 * la agente revisa la propuesta en el formulario y guarda con el botón de
 * siempre. Límite por cliente: cada llamada cuesta dinero.
 */
const TranslateSchema = z
  .object({
    title: z.string().max(300).default(''),
    summary: z.string().max(3000).default(''),
    floor: z.string().max(300).default(''),
    lacks: z.array(z.string().max(500)).max(20).default([]),
    alts: z.array(z.object({ id: z.string().max(64), text: z.string().max(300) }).strict()).max(40).default([]),
  })
  .strict();

const limiter = new InMemoryRateLimiter(60 * 60 * 1000);

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return ctx.response;
  const { id } = await props.params;
  const home = isUuid(id) ? await findOwnedHome(prisma, ctx.site.id, id.toLowerCase()) : null;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = TranslateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  if (isEmptyTranslationInput(body.data)) return NextResponse.json({ error: 'nothing_to_translate' }, { status: 400 });
  if (!limiter.check(`cartera-translate:${ctx.clientId}`, TRANSLATIONS_PER_HOUR)) return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });

  const r = await translateHomeTexts(body.data);
  if (!r.ok) {
    logError('cartera.translate', r.error, { homeId: home.id }, 'warn');
    return NextResponse.json({ error: 'translation_failed' }, { status: 502 });
  }
  if ('skipped' in r) return NextResponse.json({ error: 'ai_not_configured' }, { status: 503 });
  return NextResponse.json({ ok: true, proposal: r.proposal });
}
