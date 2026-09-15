import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { analyseImport, describeDiagnostic, IMPORT_DECLARATION_V1 } from '@/lib/contact-import';
import { loadRecallSubscription, MAX_CSV_CHARS } from '@/lib/recall-recovery-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/admin/portal/recall/[subscriptionId]/import/preview
//
// La vista previa antes de importar. No escribe nada: devuelve cómo se ha
// entendido el fichero —qué columna es cada campo, las primeras filas ya
// normalizadas, la nota de calidad— y el texto de la declaración que el
// cliente tiene que haber aceptado. Una persona lo mira ANTES de que entre
// un solo contacto: un mapeo equivocado (la "fecha" que en realidad es la
// de alta) no lo detecta ningún heurístico.
// =============================================================================

const BodySchema = z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS) });

interface Params {
  params: { subscriptionId: string };
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const subscription = await loadRecallSubscription(prisma, params.subscriptionId);
  if (!subscription) return NextResponse.json({ error: 'subscription_not_found' }, { status: 404 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const analysis = analyseImport(body.data.csv);
  return NextResponse.json({
    ok: true,
    summary: describeDiagnostic(analysis),
    quality: analysis.quality,
    diagnostic: analysis.diagnostic,
    mapping: analysis.mapping,
    preview: analysis.preview,
    declaration: IMPORT_DECLARATION_V1,
  });
}
