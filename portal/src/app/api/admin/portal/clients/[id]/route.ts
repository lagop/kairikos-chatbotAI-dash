// KAIA-13281 — Admin: PATCH /api/admin/portal/clients/[id]
//
// Operator-only endpoint that mutates a ChatbotClient row and writes one
// OperatorAction audit row per changed field in a single Prisma
// $transaction. The transaction guarantees the audit log cannot drift
// from the live row (either both commits or neither does).
//
// Allowlist:
//   companyName | email | tier | goLiveAt | state | notes
//
// Auth:
//   * `kairikos_operator_session` cookie (DB-backed OperatorSession row,
//     set by /api/operator/login) — this is the path the admin UI uses
//     after the operator signs in. Resolved by authenticateAdminRequest
//     in src/lib/operator-session.ts.
//   * `x-kaia-operator-key` header matching KAIA_OPERATOR_API_KEY (the
//     same bypass the sibling admin routes already honor — see
//     src/app/api/admin/portal/clients/[id]/password/route.ts).
//   * NextAuth session with role='operator' — kept as a final fallback
//     for the legacy operator context that flows through the client
//     portal's NextAuth sign-in.
//     getSession().isOperator, but the operator session cookie is the
//     primary path. See KAIA-1107 / KAIA-1166.
//
// Failure modes:
//   * 401 — not authenticated, or session is not an operator
//   * 400 — body is not JSON, has unknown fields, or has an invalid
//           tier/state/goLiveAt value
//   * 404 — ChatbotClient not found for [id]
//   * 500 — DB / transaction failure (audited via console.error)

import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { constantTimeEqual } from '@/lib/operator-crypto';

const ALLOWED_FIELDS = new Set([
  'companyName',
  'email',
  'tier',
  'goLiveAt',
  'state',
  'notes',
] as const);

const ALLOWED_TIERS = new Set(['starter', 'pro', 'premium'] as const);
const ALLOWED_STATES = new Set([
  'pending',
  'in-progress',
  'live',
  'paused',
  'cancelled',
] as const);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTES_MAX = 4000;
const COMPANY_NAME_MAX = 200;

// KAIA-1909 — operator-key bypass used by sibling admin routes so QA
// can curl against staging without a NextAuth cookie. Mirrors the
// constant-time comparison in src/lib/session.ts so the two paths are
// equivalent in their leak profile.
function operatorKeyAuth(req: NextRequest): boolean {
  const envKey = process.env.KAIA_OPERATOR_API_KEY;
  if (!envKey) return false;
  const provided = req.headers.get('x-kaia-operator-key');
  if (!provided) return false;
  return constantTimeEqual(provided, envKey);
}

interface CurrentClient {
  companyName: string | null;
  email: string;
  tier: string;
  goLiveAt: Date | null;
  state: string;
  notes: string | null;
}

interface FieldChange {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
  // The value to write into ChatbotClient.Prisma update (Date for
  // goLiveAt, string|null for everything else).
  patchValue: string | null | Date;
}

interface ParseOk {
  ok: true;
  changes: FieldChange[];
}
interface ParseErr {
  ok: false;
  status: number;
  error: string;
  detail?: string;
}

function jsonError(status: number, error: string, detail?: string): NextResponse {
  const body: { error: string; detail?: string } = { error };
  if (detail) body.detail = detail;
  return NextResponse.json(body, { status });
}

// Normalize a value to its TEXT representation for the audit row.
// Dates become ISO strings; nulls stay null; everything else is coerced
// to a string. The audit columns are TEXT (not JSONB) so the trail is
// human-readable from psql.
function stringifyForAudit(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseBody(raw: unknown, current: CurrentClient): ParseOk | ParseErr {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'body must be a JSON object' };
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k as 'companyName'));
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      detail: `unknown field(s): ${unknown.sort().join(', ')}`,
    };
  }
  const changes: FieldChange[] = [];

  if ('companyName' in body) {
    const raw = body.companyName;
    if (raw !== null && (typeof raw !== 'string' || raw.length === 0 || raw.length > COMPANY_NAME_MAX)) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        detail: `companyName must be a string 1–${COMPANY_NAME_MAX} chars or null`,
      };
    }
    const next = raw === null ? null : raw.trim();
    if (next !== current.companyName) {
      changes.push({
        field: 'companyName',
        beforeValue: current.companyName,
        afterValue: next,
        patchValue: next,
      });
    }
  }

  if ('email' in body) {
    const raw = body.email;
    if (typeof raw !== 'string' || !EMAIL_RE.test(raw)) {
      return { ok: false, status: 400, error: 'bad_request', detail: 'email must be a valid email string' };
    }
    const next = raw.trim().toLowerCase();
    if (next !== current.email) {
      changes.push({
        field: 'email',
        beforeValue: current.email,
        afterValue: next,
        patchValue: next,
      });
    }
  }

  if ('tier' in body) {
    const raw = body.tier;
    if (typeof raw !== 'string' || !ALLOWED_TIERS.has(raw as 'starter')) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        detail: `tier must be one of: ${Array.from(ALLOWED_TIERS).join(', ')}`,
      };
    }
    const next = raw;
    if (next !== current.tier) {
      changes.push({
        field: 'tier',
        beforeValue: current.tier,
        afterValue: next,
        patchValue: next,
      });
    }
  }

  if ('state' in body) {
    const raw = body.state;
    if (typeof raw !== 'string' || !ALLOWED_STATES.has(raw as 'pending')) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        detail: `state must be one of: ${Array.from(ALLOWED_STATES).join(', ')}`,
      };
    }
    const next = raw;
    if (next !== current.state) {
      changes.push({
        field: 'state',
        beforeValue: current.state,
        afterValue: next,
        patchValue: next,
      });
    }
  }

  if ('goLiveAt' in body) {
    const raw = body.goLiveAt;
    if (raw === null) {
      if (current.goLiveAt !== null) {
        changes.push({
          field: 'goLiveAt',
          beforeValue: stringifyForAudit(current.goLiveAt),
          afterValue: null,
          patchValue: null,
        });
      }
    } else if (typeof raw === 'string') {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, status: 400, error: 'bad_request', detail: 'goLiveAt must be an ISO datetime or null' };
      }
      if (current.goLiveAt === null || current.goLiveAt.getTime() !== parsed.getTime()) {
        changes.push({
          field: 'goLiveAt',
          beforeValue: stringifyForAudit(current.goLiveAt),
          afterValue: parsed.toISOString(),
          patchValue: parsed,
        });
      }
    } else {
      return { ok: false, status: 400, error: 'bad_request', detail: 'goLiveAt must be an ISO datetime or null' };
    }
  }

  if ('notes' in body) {
    const raw = body.notes;
    if (raw === null) {
      if (current.notes !== null) {
        changes.push({
          field: 'notes',
          beforeValue: current.notes,
          afterValue: null,
          patchValue: null,
        });
      }
    } else if (typeof raw === 'string') {
      if (raw.length > NOTES_MAX) {
        return { ok: false, status: 400, error: 'bad_request', detail: `notes must be ${NOTES_MAX} chars or fewer` };
      }
      if (current.notes !== raw) {
        changes.push({
          field: 'notes',
          beforeValue: current.notes,
          afterValue: raw,
          patchValue: raw,
        });
      }
    } else {
      return { ok: false, status: 400, error: 'bad_request', detail: 'notes must be a string or null' };
    }
  }

  return { ok: true, changes };
}

async function resolveActorId(req: NextRequest): Promise<string> {
  if (operatorKeyAuth(req)) {
    return 'operator-key-bypass@kairikos.local';
  }
  // Prefer the operator session cookie (admin-portal login path).
  const adminAuth = await authenticateAdminRequest(req);
  if (adminAuth.ok) {
    return adminAuth.operatorId;
  }
  try {
    const session = await getSession();
    return session.email ?? 'unknown-operator';
  } catch {
    return 'unknown-operator';
  }
}

function buildPrismaPatch(changes: FieldChange[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const c of changes) {
    patch[c.field] = c.patchValue;
  }
  return patch;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isDatabaseConfigured) {
    return jsonError(503, 'service_unavailable', 'DATABASE_URL is not configured');
  }

  // Three parallel auth paths, in priority order:
  //   1. kairikos_operator_session cookie (admin-portal login flow,
  //      resolved by authenticateAdminRequest). This is the path the
  //      admin UI uses after the operator signs in via
  //      /api/operator/login.
  //   2. x-kaia-operator-key header matching KAIA_OPERATOR_API_KEY
  //      (service-account / CI bypass).
  //   3. NextAuth session with role='operator' (legacy fallback).
  // Any one of these passing is sufficient for operator authority.
  let operatorAuthorized = false;
  if (operatorKeyAuth(req)) {
    operatorAuthorized = true;
  } else {
    const adminAuth = await authenticateAdminRequest(req);
    if (adminAuth.ok) {
      operatorAuthorized = true;
    } else {
      try {
        const session = await getSession();
        operatorAuthorized = session.isOperator;
      } catch (err) {
        console.error('[PATCH /api/admin/portal/clients/[id]] getSession failed', err);
        operatorAuthorized = false;
      }
    }
  }
  if (!operatorAuthorized) {
    return jsonError(401, 'unauthorized');
  }

  const clientId = params.id;
  if (!clientId) {
    return jsonError(400, 'bad_request', 'clientId is required');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'bad_request', 'body must be valid JSON');
  }

  let current: CurrentClient | null;
  try {
    current = await prisma.chatbotClient.findUnique({
      where: { id: clientId },
      select: {
        companyName: true,
        email: true,
        tier: true,
        goLiveAt: true,
        state: true,
        notes: true,
      },
    });
  } catch (err) {
    console.error('[PATCH /api/admin/portal/clients/[id]] findUnique failed', err);
    return jsonError(500, 'internal_error');
  }
  if (!current) {
    return jsonError(404, 'not_found', `ChatbotClient ${clientId} not found`);
  }

  const parsed = parseBody(body, current);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.error, parsed.detail);
  }

  if (parsed.changes.length === 0) {
    // No-op: the caller submitted fields whose values already match the
    // current row. Surface the current row + an empty actions array so
    // the caller knows the request was accepted but no audit rows were
    // emitted.
    const fresh = await prisma.chatbotClient.findUnique({
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
        updatedAt: true,
      },
    });
    return NextResponse.json({
      ok: true,
      client: fresh ? { ...fresh, goLiveAt: fresh.goLiveAt?.toISOString() ?? null } : null,
      actions: [],
    });
  }

  const actorId = await resolveActorId(req);
  const patch = buildPrismaPatch(parsed.changes);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.chatbotClient.update({
        where: { id: clientId },
        data: patch,
        select: {
          id: true,
          email: true,
          name: true,
          companyName: true,
          tier: true,
          state: true,
          goLiveAt: true,
          notes: true,
          updatedAt: true,
        },
      });
      const created = await Promise.all(
        parsed.changes.map((c) =>
          tx.operatorAction.create({
            data: {
              clientId,
              actorType: 'operator',
              actorId,
              field: c.field,
              beforeValue: c.beforeValue,
              afterValue: c.afterValue,
            },
            select: { id: true, field: true, beforeValue: true, afterValue: true, createdAt: true },
          }),
        ),
      );
      return { updated, actions: created };
    });

    return NextResponse.json({
      ok: true,
      client: { ...result.updated, goLiveAt: result.updated.goLiveAt?.toISOString() ?? null },
      actions: result.actions.map((a) => ({
        id: a.id,
        field: a.field,
        beforeValue: a.beforeValue,
        afterValue: a.afterValue,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[PATCH /api/admin/portal/clients/[id]] transaction failed', err);
    return jsonError(500, 'internal_error');
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';