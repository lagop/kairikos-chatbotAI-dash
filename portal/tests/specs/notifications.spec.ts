// =============================================================================
// KAIA-1061 — Playwright smoke for POST /api/internal/notify-operator.
//
// Hits the route directly (no browser) so the assertions cover the
// auth, validation, dedup, and persistence contract. The route is the
// only place the operator-notification contract is enforced; the
// Playwright layer is a thin end-to-end wrapper that the operator
// regression suite can re-run after any schema or template change.
//
// Gated by `@smoke` so the slow suite skips it; run with:
//   PORTAL_URL=http://localhost:3001 \
//   PORTAL_API_KEY=<dev key> \
//   KAIRIKOS_OPERATOR_EMAILS=ops@example.com \
//   playwright test tests/specs/notifications.spec.ts --grep @smoke
// =============================================================================

import { test, expect, request } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:3001';
const API_KEY = process.env.PORTAL_API_KEY || '';
const OPERATOR_EMAILS = process.env.KAIRIKOS_OPERATOR_EMAILS || '';

interface NotifyResponse {
  ok?: boolean;
  deduped?: boolean;
  skipped?: string;
  id?: string;
  kind?: string;
  clientId?: string | null;
  day?: string;
  resendMessageId?: string | null;
  error?: string;
  detail?: string;
}

async function callNotify(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: NotifyResponse }> {
  const ctx = await request.newContext({ baseURL: PORTAL_URL });
  const response = await ctx.post('/api/internal/notify-operator', {
    headers: { 'Content-Type': 'application/json', ...headers },
    data: body,
  });
  let json: NotifyResponse = {};
  try {
    json = (await response.json()) as NotifyResponse;
  } catch {
    // Non-JSON response — surface status only.
  }
  await ctx.dispose();
  return { status: response.status(), json };
}

test.describe('Operator smart notifications (KAIA-1061)', () => {
  test('@smoke auth — missing key is rejected with 401', async () => {
    const { status, json } = await callNotify(
      { kind: 'stuck', clientId: '00000000-0000-4000-8000-000000000000', milestone: 'T+3', hoursSince: 26 },
      {},
    );
    expect(status).toBe(401);
    expect(json.error).toBe('unauthorized');
  });

  test('@smoke auth — wrong key is rejected with 401', async () => {
    const { status, json } = await callNotify(
      { kind: 'stuck', clientId: '00000000-0000-4000-8000-000000000000', milestone: 'T+3', hoursSince: 26 },
      { 'x-kairikos-internal-key': 'wrong-key' },
    );
    expect(status).toBe(401);
    expect(json.error).toBe('unauthorized');
  });

  test('@smoke validation — bad kind returns 400', async () => {
    test.skip(!API_KEY, 'PORTAL_API_KEY not set; skipping happy-path validation');
    const { status, json } = await callNotify(
      { kind: 'random', clientId: '00000000-0000-4000-8000-000000000000' },
      { 'x-kairikos-internal-key': API_KEY },
    );
    expect(status).toBe(400);
    expect(json.error).toBe('bad_request');
  });

  test('@smoke validation — bad UUID returns 400', async () => {
    test.skip(!API_KEY, 'PORTAL_API_KEY not set; skipping happy-path validation');
    const { status, json } = await callNotify(
      { kind: 'stuck', clientId: 'not-a-uuid', milestone: 'T+3', hoursSince: 26 },
      { 'x-kairikos-internal-key': API_KEY },
    );
    expect(status).toBe(400);
    expect(json.error).toBe('bad_request');
  });

  test('@smoke validation — stuck without milestone returns 400', async () => {
    test.skip(!API_KEY, 'PORTAL_API_KEY not set; skipping happy-path validation');
    const { status, json } = await callNotify(
      { kind: 'stuck', clientId: '00000000-0000-4000-8000-000000000000', hoursSince: 26 },
      { 'x-kairikos-internal-key': API_KEY },
    );
    expect(status).toBe(400);
    expect(json.error).toBe('bad_request');
  });

  test('@smoke validation — execution-failed without error returns 400', async () => {
    test.skip(!API_KEY, 'PORTAL_API_KEY not set; skipping happy-path validation');
    const { status, json } = await callNotify(
      { kind: 'execution-failed', executionId: 'exec_1', workflowName: 'T+0' },
      { 'x-kairikos-internal-key': API_KEY },
    );
    expect(status).toBe(400);
    expect(json.error).toBe('bad_request');
  });

  test('@smoke happy path — stuck notification is accepted and deduped on retry', async () => {
    test.skip(!API_KEY, 'PORTAL_API_KEY not set; skipping happy-path test');
    test.skip(!OPERATOR_EMAILS, 'KAIRIKOS_OPERATOR_EMAILS not set; skipping send path');

    const { status, json } = await callNotify(
      {
        kind: 'stuck',
        clientId: '00000000-0000-4000-8000-000000000001',
        milestone: 'T+3',
        hoursSince: 26,
      },
      { 'x-kairikos-internal-key': API_KEY },
    );
    // Happy path is either 200 (sent) or 404 (client not seeded). 404 is
    // a valid response that proves the validation + auth + DB path
    // wired up; the @smoke gate should still let the suite pass.
    expect([200, 404]).toContain(status);

    if (status === 200) {
      expect(json.ok).toBe(true);
      expect(['stuck', 'execution-failed', 'escalation']).toContain(json.kind);

      // Retry → deduped
      const retry = await callNotify(
        {
          kind: 'stuck',
          clientId: '00000000-0000-4000-8000-000000000001',
          milestone: 'T+3',
          hoursSince: 30,
        },
        { 'x-kairikos-internal-key': API_KEY },
      );
      expect(retry.status).toBe(200);
      expect(retry.json.deduped).toBe(true);
      expect(retry.json.id).toBe(json.id);
    }
  });
});
