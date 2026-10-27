import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { CHECK_SAMPLES } from '@/lib/site-template-checks';
import { recordBrowserChecks } from '@/lib/site-template-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — POST /api/admin/portal/site-templates/[id]/checks
//
// Lo que midió el navegador del operador (site-template-checks.ts). Las frases
// van tal cual a la ronda de corrección, así que se acotan en número y largo:
// vienen de un navegador, y un navegador puede mandar cualquier cosa.
// =============================================================================

const BodySchema = z.object({
  runs: z
    .array(
      z.object({
        ancho: z.number().int().min(320).max(2000),
        contenido: z.enum(CHECK_SAMPLES),
        pagina: z.string().max(80).regex(/^[a-z0-9/-]*$/).optional(),
        problemas: z.array(z.string().max(2000)).max(40),
      }),
    )
    .min(1)
    .max(24),
});

export async function POST(req: NextRequest, props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });

  try {
    const result = await recordBrowserChecks(prisma, params.templateId, body.data.runs);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === 'not_found' ? 404 : 409 });
    return NextResponse.json(result);
  } catch (err) {
    logError('site_templates.checks_failed', err, { templateId: params.templateId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
