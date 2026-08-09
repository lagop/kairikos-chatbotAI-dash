// KAIA-13259 — Admin editor mode: PATCH /api/admin/portal/clients/[id]
//
// Operator-only PATCH endpoint. Accepts a JSON body with optional fields
// from the allowlist: companyName, email, tier, goLiveAt, state, notes.
// Every changed field is written to the ChatbotClient row AND to a paired
// OperatorAction audit row in the same transaction, so the audit log is
// always consistent with the client row.
//
// Auth: authenticateAdminRequest(req) — checks the
// `kairikos_operator_session` cookie first, then falls back to the legacy
// `x-kaia-operator-key` header (KAIA_OPERATOR_API_KEY). Both flavours come
// from KAIA-1107 / KAIA-1166. Returns 401 on no auth, 400 on unknown
// fields / invalid values, 404 if the client does not exist, 200 on
// success with the updated client + the new OperatorAction rows.

import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

const ALLOWED_FIELDS = [
  'companyName',
  'email',
  'tier',
  'goLiveAt',
  'state',
  'notes',
] as const;

type AllowedField = (typeof ALLOWED_FIELDS)[number];

const TIER_VALUES = new Set(['starter', 'pro', 'premium']);
const STATE_VALUES = new Set([
  'pending',
  'in-progress',
  'go-live-pending',
  'live',
  'ready',
  'updating',
  'paused',
  'cancelled',
]);

interface ClientRow {
  id: string;
  email: string;
  name: string;
  companyName: string | null;
  tier: string;
  state: string;
  goLiveAt: Date | null;
  notes: string | null;
}

function isAllowedField(name: string): name is AllowedField {
  return (ALLOWED_FIELDS as readonly string[]).includes(name);
}

type ValidationResult =
  | { ok: true; value: string | Date | null }
  | { ok: false; error: string };

function validateField(field: AllowedField, value: unknown): ValidationResult {
  if (field === 'tier') {
    if (typeof value !== 'string' || !TIER_VALUES.has(value)) {
      return { ok: false, error: `tier must be one of: ${[...TIER_VALUES].join(', ')}` };
    }
    return { ok: true, value };
  }
  if (field === 'state') {
    if (typeof value !== 'string' || !STATE_VALUES.has(value)) {
      return { ok: false, error: `state must be one of: ${[...STATE_VALUES].join(', ')}` };
    }
    return { ok: true, value };
  }
  if (field === 'email') {
    if (typeof value !== 'string' || !value.includes('@')) {
      return { ok: false, error: 'email must be a valid email address' };
    }
    return { ok: true, value: value.trim().toLowerCase() };
  }
  if (field === 'goLiveAt') {
    if (value === null) return { ok: true, value: null };
    if (typeof value !== 'string') {
      return { ok: false, error: 'goLiveAt must be an ISO datetime string or null' };
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'goLiveAt must be a valid ISO datetime string' };
    }
    return { ok: true, value: parsed };
  }
  // companyName, notes — string or null
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string or null` };
  }
  return { ok: true, value };
}

function stringifyField(field: AllowedField, row: ClientRow): string | null {
  switch (field) {
    case 'companyName':
      return row.companyName ?? null;
    case 'email':
      return row.email;
    case 'tier':
      return row.tier;
    case 'state':
      return row.state;
    case 'goLiveAt':
      return row.goLiveAt ? row.goLiveAt.toISOString() : null;
    case 'notes':
      return row.notes ?? null;
  }
  return null;
}

function stringifyInput(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const clientId = params.id;
  if (!clientId) {
    return NextResponse.json({ error: 'bad_request', detail: 'client id required' }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'bad_request', detail: 'body must be a JSON object' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request', detail: 'body must be valid JSON' }, { status: 400 });
  }

  let baseBefore: ClientRow | null;
  try {
    baseBefore = await prisma.chatbotClient.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        email: true,
        name: true,
        companyName: true,
        tier: true,
        state: true,
        goLiveAt: true,
        notes: true,
      },
    });
  } catch (err) {
    console.error('[PATCH /api/admin/portal/clients/[id]] lookup failed', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!baseBefore) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const writeData: Record<string, string | Date | null> = {};
  const pendingActions: { field: AllowedField; beforeValue: string | null; afterValue: string | null }[] = [];

  for (const fieldName of Object.keys(body)) {
    if (!isAllowedField(fieldName)) {
      return NextResponse.json(
        { error: 'bad_request', detail: `unknown field: ${fieldName}`, allowedFields: ALLOWED_FIELDS },
        { status: 400 },
      );
    }

    const validated = validateField(fieldName, body[fieldName]);
    if (!validated.ok) {
      return NextResponse.json({ error: 'bad_request', detail: validated.error }, { status: 400 });
    }

    const beforeValue = stringifyField(fieldName, baseBefore);
    const afterValue = stringifyInput(validated.value);
    if (beforeValue === afterValue) {
      continue;
    }

    writeData[fieldName] = validated.value;
    pendingActions.push({ field: fieldName, beforeValue, afterValue });
  }

  if (pendingActions.length === 0) {
    return NextResponse.json({
      ok: true,
      client: baseBefore,
      actions: [],
      note: 'no changes',
    });
  }

  const actorId = auth.operatorId;
  const actions = await prisma.$transaction(async (tx) => {
    const updated = await tx.chatbotClient.update({
      where: { id: clientId },
      data: writeData,
      select: {
        id: true,
        email: true,
        name: true,
        companyName: true,
        tier: true,
        state: true,
        goLiveAt: true,
        notes: true,
      },
    });

    const created = await Promise.all(
      pendingActions.map((action) =>
        tx.operatorAction.create({
          data: {
            clientId,
            actorType: 'operator',
            actorId,
            field: action.field,
            beforeValue: action.beforeValue,
            afterValue: action.afterValue,
          },
          select: {
            id: true,
            field: true,
            beforeValue: true,
            afterValue: true,
            createdAt: true,
          },
        }),
      ),
    );

    return { updated, created };
  });

  return NextResponse.json({
    ok: true,
    client: actions.updated,
    actions: actions.created.map((action) => ({
      id: action.id,
      field: action.field,
      beforeValue: action.beforeValue,
      afterValue: action.afterValue,
      createdAt: action.createdAt.toISOString(),
    })),
  });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
