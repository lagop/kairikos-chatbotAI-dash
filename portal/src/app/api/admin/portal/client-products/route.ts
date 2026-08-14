import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

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
  const client = await prisma.chatbotClient.findUnique({ where: { id: clientId }, select: { id: true, tenantId: true } });
  if (!client) return NextResponse.json({ error: 'client_not_found' }, { status: 404 });
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, isActive: true } });
  if (!product || !product.isActive) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const existing = await prisma.clientProduct.findUnique({
    where: { clientId_productId: { clientId, productId } },
    select: { status: true },
  });

  // WP-18 — assigning/reactivating a product and recording the audit row
  // must be atomic: an operator action that changed the client's product
  // access with no matching ClientProductAudit row would be invisible to
  // anyone auditing the account later.
  const row = await prisma.$transaction(async (tx) => {
    const clientProduct = await tx.clientProduct.upsert({
      where: { clientId_productId: { clientId, productId } },
      create: { clientId, productId, tenantId: client.tenantId, status: 'active', createdBy: auth.operatorId, changedBy: auth.operatorId },
      update: { status: 'active', cancelledAt: null, changedBy: auth.operatorId },
      include: { product: true, client: { select: { id: true, name: true, companyName: true, email: true } } },
    });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: clientProduct.id,
        clientId,
        productId,
        tenantId: client.tenantId,
        action: existing ? 'reactivate' : 'assign',
        statusBefore: existing?.status ?? null,
        statusAfter: 'active',
        actorId: auth.operatorId,
      },
    });
    return clientProduct;
  });
  return NextResponse.json(row, { status: 201 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
