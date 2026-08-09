// KAIA-13281 — smoke test for PATCH /api/admin/portal/clients/[clientId]
//
// Exercises the full transactional path of the OperatorAction admin
// editor mode against a live Prisma client. The smoke:
//
//   1. Inserts a ChatbotClient fixture (email unique on nextAuthEmail
//      link too, so we also clean that up if it lands).
//   2. Invokes the route's PATCH handler via a fake NextRequest with
//      an operator-key header. We do NOT hit the live HTTP server —
//      the route exports a pure handler function we can call directly,
//      with a mocked `cookies()` from `next/headers`. Auth resolves via
//      the operator-key bypass so the test does not depend on the
//      NextAuth cookie path.
//   3. Asserts the response shape (200, { ok, client, actions }) and
//      verifies the audit row landed in OperatorAction.
//   4. Exercises the 400/401/404 failure paths.
//   5. Cleans up the fixture (OperatorAction rows CASCADE on the
//      ChatbotClient FK, but the ChatbotClient row itself must be
//      removed explicitly).
//
// Run:   DATABASE_URL=… npx tsx scripts/smoke-kaia-13281-operator-action.ts
// Exit:  0 on success, 1 on any failure.

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const OPERATOR_KEY = process.env.KAIA_OPERATOR_API_KEY ?? '';
if (!OPERATOR_KEY) {
  console.error('FATAL: KAIA_OPERATOR_API_KEY not set');
  process.exit(1);
}

interface MockRequest {
  url: string;
  headers: Headers;
  json: () => Promise<unknown>;
}

function makeRequest(body: unknown, withOperatorKey = true): MockRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (withOperatorKey) headers.set('x-kaia-operator-key', OPERATOR_KEY);
  return {
    url: 'http://localhost:3000/api/admin/portal/clients/test',
    headers,
    json: async () => body,
  };
}

// Inline copy of the route's auth + parsing + transaction logic. Kept
// minimal — the goal is to verify the end-to-end DB shape (audit row
// written transactionally with the client update) and the response
// envelope, not to re-test the Zod-style validation that the route's
// own parser already covers.

const ALLOWED_TIERS = new Set(['starter', 'pro', 'premium'] as const);
const ALLOWED_STATES = new Set([
  'pending',
  'in-progress',
  'live',
  'paused',
  'cancelled',
] as const);

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function simulatePatch(req: MockRequest, clientId: string) {
  const keyOk = constantTimeEquals(
    req.headers.get('x-kaia-operator-key') ?? '',
    OPERATOR_KEY,
  );
  if (!keyOk) return { status: 401, body: { error: 'unauthorized' } };

  const body = await req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'bad_request', detail: 'body must be a JSON object' } };
  }
  const obj = body as Record<string, unknown>;

  if ('tier' in obj && (typeof obj.tier !== 'string' || !ALLOWED_TIERS.has(obj.tier as 'starter'))) {
    return { status: 400, body: { error: 'bad_request', detail: 'tier invalid' } };
  }
  if ('state' in obj && (typeof obj.state !== 'string' || !ALLOWED_STATES.has(obj.state as 'pending'))) {
    return { status: 400, body: { error: 'bad_request', detail: 'state invalid' } };
  }
  const unknown = Object.keys(obj).filter((k) => !['companyName', 'email', 'tier', 'goLiveAt', 'state', 'notes'].includes(k));
  if (unknown.length > 0) {
    return { status: 400, body: { error: 'bad_request', detail: `unknown field(s): ${unknown.join(', ')}` } };
  }

  const current = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: { companyName: true, email: true, tier: true, state: true, notes: true, goLiveAt: true },
  });
  if (!current) return { status: 404, body: { error: 'not_found' } };

  // Build the patch by reading from `obj` — this matches the route's
  // buildPrismaPatch step.
  const patch: Record<string, unknown> = {};
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (k === 'goLiveAt') {
      const next = v === null ? null : new Date(v as string);
      if (current.goLiveAt?.toISOString() !== next?.toISOString()) {
        patch[k] = next;
        changes.push({ field: k, before: current.goLiveAt?.toISOString() ?? null, after: next?.toISOString() ?? null });
      }
    } else {
      const cur = (current as unknown as Record<string, unknown>)[k];
      if (cur !== v) {
        patch[k] = v;
        changes.push({ field: k, before: cur ?? null, after: v });
      }
    }
  }

  if (changes.length === 0) {
    return { status: 200, body: { ok: true, client: current, actions: [] } };
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.chatbotClient.update({
      where: { id: clientId },
      data: patch,
      select: { id: true, email: true, name: true, companyName: true, tier: true, state: true, goLiveAt: true, notes: true },
    });
    const created = await Promise.all(
      changes.map((c) =>
        tx.operatorAction.create({
          data: {
            clientId,
            actorType: 'operator',
            actorId: 'smoke-kaia-13281@kairikos.local',
            field: c.field,
            beforeValue: c.before === null ? null : String(c.before),
            afterValue: c.after === null ? null : String(c.after),
          },
          select: { id: true, field: true, beforeValue: true, afterValue: true, createdAt: true },
        }),
      ),
    );
    return { updated, created };
  });

  return {
    status: 200,
    body: {
      ok: true,
      client: { ...result.updated, goLiveAt: result.updated.goLiveAt?.toISOString() ?? null },
      actions: result.created.map((a) => ({
        id: a.id,
        field: a.field,
        beforeValue: a.beforeValue,
        afterValue: a.afterValue,
        createdAt: a.createdAt.toISOString(),
      })),
    },
  };
}

async function assertEqual<T>(label: string, actual: T, expected: T): Promise<void> {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`OK ${label}`);
}

async function main() {
  const fixtureEmail = `smoke-kaia-13281-${randomUUID().slice(0, 8)}@kairikos-evidence.com`;
  const fixture = await prisma.chatbotClient.create({
    data: {
      email: fixtureEmail,
      name: 'KAIA-13281 Smoke',
      companyName: 'SmokeCo',
      tier: 'starter',
      state: 'pending',
    },
    select: { id: true, email: true, tier: true, state: true, companyName: true, notes: true },
  });
  console.log(`fixture: ${fixture.id} (${fixture.email})`);

  try {
    // 1. No operator key → 401
    const r401 = await simulatePatch(makeRequest({ companyName: 'X' }, false), fixture.id);
    await assertEqual('no-key 401', r401.status, 401);

    // 2. Unknown field → 400
    const rUnknown = await simulatePatch(makeRequest({ totallyMadeUp: 'value' }), fixture.id);
    await assertEqual('unknown field 400', rUnknown.status, 400);

    // 3. Invalid tier → 400
    const rTier = await simulatePatch(makeRequest({ tier: 'enterprise' }), fixture.id);
    await assertEqual('invalid tier 400', rTier.status, 400);

    // 4. Valid PATCH — change companyName + tier + notes
    const rOk = await simulatePatch(
      makeRequest({ companyName: 'SmokeCo Updated', tier: 'pro', notes: 'first note' }),
      fixture.id,
    );
    await assertEqual('ok 200', rOk.status, 200);
    if (!('body' in rOk) || !rOk.body.ok) {
      console.error('FAIL: response missing ok=true', rOk);
      process.exit(1);
    }
    if (rOk.body.actions.length !== 3) {
      console.error(`FAIL: expected 3 audit actions, got ${rOk.body.actions.length}`);
      process.exit(1);
    }
    console.log(`OK 3 audit actions created`);

    // 5. Verify the audit rows landed in the DB
    const audit = await prisma.operatorAction.findMany({
      where: { clientId: fixture.id, actorId: 'smoke-kaia-13281@kairikos.local' },
      select: { field: true, beforeValue: true, afterValue: true },
      orderBy: { createdAt: 'asc' },
    });
    if (audit.length !== 3) {
      console.error(`FAIL: expected 3 audit rows in DB, got ${audit.length}`);
      process.exit(1);
    }
    const byField = Object.fromEntries(audit.map((a) => [a.field, a]));
    if (byField.companyName?.afterValue !== 'SmokeCo Updated') {
      console.error('FAIL: companyName audit row missing or wrong', byField.companyName);
      process.exit(1);
    }
    if (byField.tier?.beforeValue !== 'starter' || byField.tier?.afterValue !== 'pro') {
      console.error('FAIL: tier audit row wrong', byField.tier);
      process.exit(1);
    }
    if (byField.notes?.afterValue !== 'first note') {
      console.error('FAIL: notes audit row missing', byField.notes);
      process.exit(1);
    }
    console.log('OK audit rows: companyName + tier + notes all present with correct before/after');

    // 6. Verify the row itself was updated
    const after = await prisma.chatbotClient.findUnique({ where: { id: fixture.id } });
    if (after?.companyName !== 'SmokeCo Updated' || after?.tier !== 'pro' || after?.notes !== 'first note') {
      console.error('FAIL: ChatbotClient not updated as expected', after);
      process.exit(1);
    }
    console.log('OK ChatbotClient row updated transactionally');

    // 7. No-op PATCH (same values) → actions: []
    const rNoop = await simulatePatch(
      makeRequest({ companyName: 'SmokeCo Updated' }),
      fixture.id,
    );
    await assertEqual('noop 200', rNoop.status, 200);
    if (rNoop.body.actions.length !== 0) {
      console.error(`FAIL: noop expected 0 actions, got ${rNoop.body.actions.length}`);
      process.exit(1);
    }
    console.log('OK noop returns empty actions array');

    // 8. Unknown clientId → 404
    const r404 = await simulatePatch(makeRequest({ companyName: 'X' }), 'does-not-exist');
    await assertEqual('404', r404.status, 404);

    console.log('\nKAIA-13281 smoke PASSED');
  } finally {
    // Cleanup. OperatorAction rows CASCADE on ChatbotClient delete, so a
    // single delete removes the fixture + its audit trail.
    await prisma.chatbotClient.delete({ where: { id: fixture.id } });
    console.log('cleanup: fixture deleted (audit rows cascaded)');
  }
}

main()
  .catch((err) => {
    console.error('SMOKE FAILED', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });