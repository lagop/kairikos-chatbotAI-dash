import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { startSiteTemplateGeneration } from '@/lib/site-template-jobs';
import { listSiteTemplates } from '@/lib/site-template-library';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — GET/POST /api/admin/portal/site-templates
//
// La biblioteca de plantillas: listarla y encargar una nueva a la IA. Solo
// operador. Encargar responde en cuanto crea la fila; la generación (2–3 min)
// sigue en segundo plano y la página consulta el estado.
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  return NextResponse.json({ templates: await listSiteTemplates(prisma) });
}

const BodySchema = z.object({
  nombre: z.string().trim().min(1).max(80),
  sector: z.string().trim().min(1).max(40),
  encargo: z.string().trim().min(10).max(1500),
  variante: z.string().trim().max(80).optional().nullable(),
  modelo: z.enum(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });

  try {
    const result = await startSiteTemplateGeneration(prisma, {
      nombre: body.data.nombre,
      brief: { sector: body.data.sector, encargo: body.data.encargo, variante: body.data.variante ?? null },
      modelo: body.data.modelo ?? null,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 429 });
    return NextResponse.json({ ok: true, id: result.id }, { status: 202 });
  } catch (err) {
    logError('site_templates.start_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
