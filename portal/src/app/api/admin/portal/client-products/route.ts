import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { activateClientProductForOperator } from '@/lib/client-product-activation';

const ProductIdSchema = z.string().uuid();
const ClientIdSchema = z.string().min(1).max(128);

function unavailable() {
  return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
}

async function requireAdmin(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  return auth.ok ? auth : null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return unavailable();

  const clientId = req.nextUrl.searchParams.get('clientId');
  if (clientId && !ClientIdSchema.safeParse(clientId).success) {
    return NextResponse.json({ error: 'bad_request', detail: 'invalid clientId' }, { status: 400 });
  }

  const rows = await prisma.clientProduct.findMany({
    where: clientId ? { clientId } : undefined,
    orderBy: { changedAt: 'desc' },
    include: {
      client: { select: { id: true, name: true, companyName: true, email: true } },
      product: { select: { id: true, code: true, name: true, tier: true, priceCents: true, setupFeeCents: true, currency: true, features: true, isActive: true } },
      auditLogs: { orderBy: { changedAt: 'desc' }, take: 20 },
    },
  });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return unavailable();

  const body = z.object({ clientId: ClientIdSchema, productId: ProductIdSchema }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });

  const { clientId, productId } = body.data;

  // La transacción + auditoría + enganches de onboarding por producto
  // (recall/seo/prospecting/leads) viven en client-product-activation.ts
  // — segundo llamante real: POST /api/admin/portal/clients (alta manual
  // de cliente) necesita exactamente lo mismo al activar un producto sin
  // pasar por Stripe.
  const result = await activateClientProductForOperator(prisma, { clientId, productId }, {
    operatorId: auth.operatorId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  // Antes esta respuesta traía .client y .product completos — nadie los
  // lee (ProductAssignment.tsx solo llama router.refresh() tras un 201;
  // los .json() del componente son solo para el mensaje de error). Se
  // simplifica a lo que de verdad se usa en vez de reconsultar la fila
  // entera solo para no cambiar una forma que nadie mira.
  return NextResponse.json(
    { id: result.clientProductId, clientId, productId, productCode: result.productCode, status: 'active' },
    { status: 201 },
  );
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
