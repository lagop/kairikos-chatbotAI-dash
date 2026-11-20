import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findSiteForBuildNotice, verifyBuildSecret } from '@/lib/cartera/site';
import { allowBuildNotice } from '@/lib/cartera/public-http';
import { recordNotice } from '@/lib/cartera/publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/public/cartera/[token]/publicacion
 *   Authorization: Bearer <secreto de publicación>
 *   { buildId: string|null, status: 'en_curso'|'ok'|'fallida', stage?, release?, runUrl, commit? }
 *
 * Cartera — el aviso de .github/workflows/publicar.yml de la web
 * (docs/publicacion.md allí, «Contrato con el portal»): `en_curso` al empezar,
 * con el enlace de la ejecución, y el resultado al terminar. El de inicio no
 * trae `stage` ni `release`: por eso son opcionales, no solo anulables.
 *
 * Lo autentica el secreto de publicación, comparado contra su hash en tiempo
 * constante; el token solo dice de qué sitio es. La lógica, en
 * lib/cartera/publish.ts (recordNotice).
 */
const NoticeSchema = z.object({
  buildId: z.string().max(64).nullable(),
  status: z.enum(['en_curso', 'ok', 'fallida']),
  stage: z.enum(['construir', 'subir']).nullable().optional(),
  release: z.string().max(100).nullable().optional(),
  runUrl: z
    .string()
    .max(300)
    .url()
    .refine((u) => u.startsWith('https://'), 'https'),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable()
    .optional(),
});

export async function POST(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const { token } = await props.params;
  if (!allowBuildNotice(token)) return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });

  const site = await findSiteForBuildNotice(prisma, token);
  if (!site) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const header = req.headers.get('authorization') ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!verifyBuildSecret(secret, site.buildSecretHash)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = NoticeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const r = await recordNotice(prisma, site, body.data);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
  return NextResponse.json({ ok: true, status: r.status });
}
