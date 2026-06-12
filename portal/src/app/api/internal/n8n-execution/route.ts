import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';

// POST /api/internal/n8n-execution
// n8n calls this at the end of every T+N workflow (success or failure).
// Auth: PORTAL_API_KEY in x-portal-api-key or x-kairikos-internal-key header.
// Upserts by id so delayed completion callbacks are idempotent.
// KAIA-1073

interface N8nExecutionBody {
  id?: unknown;
  clientId?: unknown;
  clientName?: unknown;
  workflow?: unknown;
  milestone?: unknown;
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}

const VALID_STATUSES = new Set(['success', 'failed', 'running']);

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ ok: true, id: null, note: 'database_not_configured' });
  }

  let body: N8nExecutionBody;
  try {
    body = (await req.json()) as N8nExecutionBody;
  } catch {
    return NextResponse.json({ error: 'bad_request', detail: 'body must be valid JSON' }, { status: 400 });
  }

  if (typeof body.id !== 'string' || body.id.length === 0) {
    return NextResponse.json({ error: 'bad_request', detail: 'id is required' }, { status: 422 });
  }
  if (typeof body.workflow !== 'string' || body.workflow.length === 0) {
    return NextResponse.json({ error: 'bad_request', detail: 'workflow is required' }, { status: 422 });
  }
  if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) {
    return NextResponse.json({ error: 'bad_request', detail: 'status must be success | failed | running' }, { status: 422 });
  }
  if (typeof body.startedAt !== 'string') {
    return NextResponse.json({ error: 'bad_request', detail: 'startedAt is required (ISO string)' }, { status: 422 });
  }

  const clientId = typeof body.clientId === 'string' && body.clientId.length > 0 ? body.clientId : null;

  let resolvedClientName: string | null =
    typeof body.clientName === 'string' && body.clientName.length > 0 ? body.clientName : null;

  if (clientId && !resolvedClientName) {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: clientId },
      select: { companyName: true, name: true },
    });
    if (client) resolvedClientName = client.companyName ?? client.name;
  }

  const data = {
    clientId,
    clientName: resolvedClientName,
    workflow: body.workflow as string,
    milestone: typeof body.milestone === 'string' ? body.milestone : null,
    status: body.status as string,
    startedAt: new Date(body.startedAt as string),
    finishedAt: typeof body.finishedAt === 'string' ? new Date(body.finishedAt) : null,
    errorCode: typeof body.errorCode === 'string' ? body.errorCode.slice(0, 100) : null,
    errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage.slice(0, 4000) : null,
  };

  try {
    const row = await prisma.n8nExecution.upsert({
      where: { id: body.id as string },
      create: { id: body.id as string, ...data },
      update: data,
      select: { id: true },
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('[POST /api/internal/n8n-execution]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
