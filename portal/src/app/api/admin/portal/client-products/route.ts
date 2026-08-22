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
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, isActive: true, code: true } });
  if (!product || !product.isActive) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  // WP-XX — 'web' is exempt from the one-row-per-client rule (see
  // ClientProduct's schema comment): a client can have multiple
  // independent 'web' projects, so this route always creates a FRESH
  // row for 'web' rather than reusing/reactivating an existing one
  // (reusing an id would conflate two projects' WebBrief/WebQuote
  // histories, both 1:1-keyed to the ClientProduct id). This route is
  // no longer the primary way to assign 'web' — ProductAssignment.tsx
  // excludes it from the generic panel, directing operators to the
  // quote flow instead — but this stays correct as defense in depth
  // against a direct API call. Every OTHER product code keeps today's
  // find-or-reuse-cancelled-row behavior, backed by the partial unique
  // index (see that migration) that still guarantees one row per
  // (clientId, productId) for them.
  const existing =
    product.code === 'web'
      ? null
      : await prisma.clientProduct.findFirst({
          where: { clientId, productId },
          select: { id: true, status: true },
        });

  // WP-18 — assigning/reactivating a product and recording the audit row
  // must be atomic: an operator action that changed the client's product
  // access with no matching ClientProductAudit row would be invisible to
  // anyone auditing the account later.
  const row = await prisma.$transaction(async (tx) => {
    const clientProduct = existing
      ? await tx.clientProduct.update({
          where: { id: existing.id },
          data: { status: 'active', cancelledAt: null, changedBy: auth.operatorId },
          include: { product: true, client: { select: { id: true, name: true, companyName: true, email: true } } },
        })
      : await tx.clientProduct.create({
          data: { clientId, productId, tenantId: client.tenantId, status: 'active', createdBy: auth.operatorId, changedBy: auth.operatorId },
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
