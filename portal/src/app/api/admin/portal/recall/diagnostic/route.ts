import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { analyseImport, describeDiagnostic } from '@/lib/contact-import';
import { MAX_CSV_CHARS } from '@/lib/recall-recovery-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/admin/portal/recall/diagnostic — la herramienta de venta.
//
// El comercial sube el export de un PROSPECTO y le enseña su propio dinero:
// cuántos clientes tiene, cuántos llevan año y medio sin saber de él, cuánto
// ha facturado. Sin contrato y sin cliente en el sistema.
//
// NO ESCRIBE NADA Y NO GUARDA EL FICHERO. El documento pedía "borrado
// automático si no se convierte en cliente en N días"; la forma más
// sencilla de cumplirlo es no guardar nunca nada que haya que borrar. El
// CSV vive lo que dura esta petición. Si el prospecto firma, se importa de
// verdad desde su ficha, con su declaración de origen.
// =============================================================================

const BodySchema = z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS) });

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

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
  });
}
