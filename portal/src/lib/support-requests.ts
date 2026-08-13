// =============================================================================
// WP-11 — read/write helpers for the SupportRequest table.
//
// Persists client "Necesito ayuda" submissions independently of the
// OperatorNotification email-dedup row (see the migration header in
// prisma/migrations/20260813120000_support_request_table/migration.sql
// for why that table alone wasn't enough). This file is the only place
// that touches SupportRequest so the admin inbox and the client-facing
// route share the same status vocabulary.
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';

export type SupportRequestStatus = 'open' | 'resolved';

export interface SupportRequestRow {
  id: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  subject: string;
  message: string;
  status: SupportRequestStatus;
  resolvedByOperatorId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export async function createSupportRequest(
  prisma: PrismaClient,
  input: { clientId: string; tenantId?: string | null; subject: string; message: string },
): Promise<{ id: string; createdAt: Date }> {
  return prisma.supportRequest.create({
    data: {
      clientId: input.clientId,
      tenantId: input.tenantId ?? null,
      subject: input.subject,
      message: input.message,
    },
    select: { id: true, createdAt: true },
  });
}

/**
 * Lists support requests newest-first, joined with the client's display
 * name/email for the admin inbox. `status` filters to open/resolved;
 * omit for the full history.
 */
export async function listSupportRequests(
  prisma: PrismaClient,
  opts: { status?: SupportRequestStatus } = {},
): Promise<SupportRequestRow[]> {
  const where: Prisma.SupportRequestWhereInput = opts.status ? { status: opts.status } : {};
  const rows = await prisma.supportRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      clientId: true,
      subject: true,
      message: true,
      status: true,
      resolvedByOperatorId: true,
      resolvedAt: true,
      createdAt: true,
      client: { select: { name: true, companyName: true, email: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.client.companyName ?? r.client.name,
    clientEmail: r.client.email,
    subject: r.subject,
    message: r.message,
    status: r.status === 'resolved' ? 'resolved' : 'open',
    resolvedByOperatorId: r.resolvedByOperatorId,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type ResolveSupportRequestResult =
  | { ok: true; status: SupportRequestStatus }
  | { ok: false; error: 'not_found' };

/**
 * Flips a request's status. Idempotent in both directions — re-resolving
 * an already-resolved request just refreshes resolvedAt/resolvedByOperatorId;
 * re-opening a resolved request clears them.
 */
export async function setSupportRequestStatus(
  prisma: PrismaClient,
  id: string,
  status: SupportRequestStatus,
  operatorId: string,
): Promise<ResolveSupportRequestResult> {
  const existing = await prisma.supportRequest.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { ok: false, error: 'not_found' };

  await prisma.supportRequest.update({
    where: { id },
    data:
      status === 'resolved'
        ? { status: 'resolved', resolvedByOperatorId: operatorId, resolvedAt: new Date() }
        : { status: 'open', resolvedByOperatorId: null, resolvedAt: null },
  });
  return { ok: true, status };
}
