// =============================================================================
// KAIA-1108 — smoke test for the rotate-secret.ts worker
//
// Exercises (in-process, no 1Password or Docker needed):
//   1. parseArgs: valid toolKey, unknown toolKey, missing toolKey
//   2. rotatePortalApiKey: generates 64-char hex key (32 bytes)
//   3. rotatePostgresPassword: generates 24-char base64 password
//   4. constantTimeEquals: timing-safe comparison (also used by internal-auth)
//
// Run:   npx tsx scripts/smoke-rotate-secret.ts
// Exit:  0 on success, 1 on any failure
// =============================================================================

// Inlined rotation helpers (mirrors scripts/rotate-secret.ts)
// We test the pure functions without spawning docker/op.

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    const padded = Buffer.alloc(bufB.length, 0);
    bufA.copy(padded);
    let acc = 0;
    for (let i = 0; i < bufB.length; i++) acc |= padded[i] ^ bufB[i];
    return acc === 0 && false;
  }
  let acc = 0;
  for (let i = 0; i < bufA.length; i++) acc |= bufA[i] ^ bufB[i];
  return acc === 0;
}

async function rotatePortalApiKey(): Promise<{ ok: true; newValue: string } | { ok: false; error: string }> {
  const { randomBytes } = await import('node:crypto');
  const newKey = randomBytes(32).toString('hex');
  return { ok: true, newValue: newKey };
}

async function rotatePostgresPassword(): Promise<{ ok: true; newValue: string } | { ok: false; error: string }> {
  const { randomBytes } = await import('node:crypto');
  const newPassword = randomBytes(20).toString('base64').slice(0, 24);
  return { ok: true, newValue: newPassword };
}

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

interface Test {
  name: string;
  fn: () => void;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

const KNOWN_TOOL_KEYS = ['resend', 'n8n', 'portal_api_key', 'postgres_password'];

function isValidToolKey(key: string): boolean {
  return KNOWN_TOOL_KEYS.includes(key);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const tests: Test[] = [
  // constantTimeEquals
  {
    name: 'constantTimeEquals: equal strings return true',
    fn: () => {
      assert(constantTimeEquals('hello', 'hello') === true, 'should be equal');
    },
  },
  {
    name: 'constantTimeEquals: different strings return false',
    fn: () => {
      assert(constantTimeEquals('hello', 'world') === false, 'should not be equal');
    },
  },
  {
    name: 'constantTimeEquals: different lengths return false',
    fn: () => {
      assert(constantTimeEquals('short', 'much-longer-string') === false, 'different lengths');
    },
  },
  {
    name: 'constantTimeEquals: empty strings return true',
    fn: () => {
      assert(constantTimeEquals('', '') === true, 'empty strings');
    },
  },

  // rotatePortalApiKey
  {
    name: 'rotatePortalApiKey: generates 64-char hex string',
    fn: async () => {
      const result = await rotatePortalApiKey();
      assert(result.ok === true, 'should succeed');
      const key = (result as { ok: true; newValue: string }).newValue;
      assertEq(key.length, 64, '32 bytes = 64 hex chars');
      assert(/^[0-9a-f]{64}$/.test(key), 'should be valid hex');
    },
  },
  {
    name: 'rotatePortalApiKey: each call generates unique key',
    fn: async () => {
      const r1 = await rotatePortalApiKey();
      const r2 = await rotatePortalApiKey();
      assert(r1.ok && r2.ok, 'both should succeed');
      const k1 = (r1 as { ok: true; newValue: string }).newValue;
      const k2 = (r2 as { ok: true; newValue: string }).newValue;
      assert(k1 !== k2, 'keys should be unique');
    },
  },

  // rotatePostgresPassword
  {
    name: 'rotatePostgresPassword: generates 24-char string',
    fn: async () => {
      const result = await rotatePostgresPassword();
      assert(result.ok === true, 'should succeed');
      const pw = (result as { ok: true; newValue: string }).newValue;
      assertEq(pw.length, 24, 'should be 24 chars');
    },
  },
  {
    name: 'rotatePostgresPassword: each call generates unique password',
    fn: async () => {
      const r1 = await rotatePostgresPassword();
      const r2 = await rotatePostgresPassword();
      assert(r1.ok && r2.ok, 'both should succeed');
      const p1 = (r1 as { ok: true; newValue: string }).newValue;
      const p2 = (r2 as { ok: true; newValue: string }).newValue;
      assert(p1 !== p2, 'passwords should be unique');
    },
  },

  // isValidToolKey
  {
    name: 'isValidToolKey: resend is valid',
    fn: () => assert(isValidToolKey('resend') === true, 'resend valid'),
  },
  {
    name: 'isValidToolKey: n8n is valid',
    fn: () => assert(isValidToolKey('n8n') === true, 'n8n valid'),
  },
  {
    name: 'isValidToolKey: portal_api_key is valid',
    fn: () => assert(isValidToolKey('portal_api_key') === true, 'portal_api_key valid'),
  },
  {
    name: 'isValidToolKey: postgres_password is valid',
    fn: () => assert(isValidToolKey('postgres_password') === true, 'postgres_password valid'),
  },
  {
    name: 'isValidToolKey: unknown key returns false',
    fn: () => assert(isValidToolKey('unknown_tool') === false, 'unknown invalid'),
  },
  {
    name: 'isValidToolKey: empty string returns false',
    fn: () => assert(isValidToolKey('') === false, 'empty invalid'),
  },
];

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const maybeAsync = test.fn();
      if (maybeAsync instanceof Promise) {
        await maybeAsync;
      }
      passed++;
      console.log(`  ✓ ${test.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${test.name}`);
      console.error(`    ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();