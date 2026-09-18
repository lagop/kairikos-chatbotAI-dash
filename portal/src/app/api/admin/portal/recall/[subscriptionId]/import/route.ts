import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { commitImport, IMPORT_DECLARATION_V1 } from '@/lib/contact-import';
import { loadRecallSubscription, resolveAttributableOperator, MAX_CSV_CHARS } from '@/lib/recall-recovery-admin';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/admin/portal/recall/[subscriptionId]/import — importar de verdad.
//
// TRES COSAS QUE ESTA RUTA NO DEJA HACER:
//
//   · Importar sin confirmar que el cliente aceptó la declaración de origen
//     (`clientAccepted: true`). Los contactos importados nunca pasaron por
//     el aviso de oposición; lo único que sostiene poder escribirles es esa
//     declaración. commitImport además se niega sin ella.
//
//   · Elegir el texto de la declaración. Lo pone el servidor
//     (IMPORT_DECLARATION_V1): si viniera del cuerpo, lo que queda guardado
//     como "lo que aceptó el cliente" sería lo que mandó el navegador.
//
//   · Importar sin un operador identificable. La clave de API heredada no
//     vale: la importación queda firmada por quien la hizo.
// =============================================================================

const BodySchema = z.object({
  csv: z.string().min(1).max(MAX_CSV_CHARS),
  filename: z.string().max(200).optional(),
  clientAccepted: z.literal(true),
});

interface Params {
  params: { subscriptionId: string };
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const operator = await resolveAttributableOperator(prisma, auth.operatorId);
  if (!operator.ok) return NextResponse.json({ error: operator.reason }, { status: 403 });

  const subscription = await loadRecallSubscription(prisma, params.subscriptionId);
  if (!subscription) return NextResponse.json({ error: 'subscription_not_found' }, { status: 404 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'declaration_not_accepted_or_bad_request' }, { status: 400 });
  }

  try {
    const result = await commitImport(prisma, {
      clientId: subscription.clientId,
      tenantId: subscription.tenantId,
      // Fase 3 multi-instancia — el histórico importado es de ESTA línea.
      subscriptionId: subscription.id,
      csvText: body.data.csv,
      filename: body.data.filename ?? null,
      legalDeclaration: IMPORT_DECLARATION_V1,
      // Quién lo dejó constar, no quién aceptó: el cliente aceptó
      // (clientAccepted), el operador lo registró. Queda escrito así para
      // que nadie lo lea como una declaración hecha por Kairikos.
      declaredBy: `operator:${operator.email}`,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logError('recall_recovery.import_failed', err, { subscriptionId: subscription.id }, 'warn');
    return NextResponse.json({ error: 'import_failed' }, { status: 500 });
  }
}
