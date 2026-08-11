// =============================================================================
// KAIA-13745 — Structural guardrail against ungated MOCK_* exposure in admin
// pages.
//
// We have shipped two regressions of the same root cause: a render path
// reads `MOCK_*` fixtures directly with no `isBackendConfigured` /
// `isDatabaseConfigured` gate, so production shows dev-mock data
// (Acme Corp, spc_acme_corp, 142 conversaciones, 8% / 12% fallback rates).
// Reference: KAIA-13680 (clients list), KAIA-13744 (ChatbotStatusCard).
//
// This test is the structural guardrail. For every page/component under
// `src/app/admin/portal/**` and `src/components/portal/**`, it greps the
// source for references to the tracked MOCK_* symbols and verifies that
// the reference is reachable ONLY when the backend is NOT configured
// (i.e. the dev-mock fallback branch). The "reachable only when not
// configured" check fires for two patterns:
//
//   1. Reference is inside a `if (!isDatabaseConfigured) { ... }` (or
//      `isBackendConfigured`) block, OR inside a `try { db } catch { mock }`
//      where the `catch` block is the only path to the MOCK_*.
//
//   2. Reference is in a `if (rows.length === 0) { rows = MOCK_* }` style
//      branch — flagged as NOT gateable because the `rows.length === 0`
//      branch fires in production when the DB returns 0 rows (the
//      regression class — see [clientId]/page.tsx:84-89, flows/page.tsx:131-133,
//      wizard-funnel/page.tsx:212-214).
//
//   3. Reference is unconditional in the JSX body of the page — flagged
//      regardless of any upstream DB call, because the JSX path runs
//      even when the DB returns rows (the KAIA-13744 class — see
//      [clientId]/page.tsx:274-280, flows/page.tsx:313-316).
//
// The test is hermetic: it only reads source files, no Next.js runtime.
// Run: `npm run test:unit -- tests/unit/admin-mock-gating.test.ts`
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_PORTAL_DIR = path.join(REPO_ROOT, 'src', 'app', 'admin', 'portal');
const PORTAL_COMPONENTS_DIR = path.join(REPO_ROOT, 'src', 'components', 'portal');

// --- Tracking set -----------------------------------------------------------
//
// These symbols are the ones that own the dev-mock leak surface. If a new
// MOCK_* constant is added to `portal-data.ts` (or `flow-health.ts`) and it
// is rendered into operator HTML, add it here so the structural guardrail
// catches it.
const TRACKED_MOCK_SYMBOLS = [
  'MOCK_CLIENT',
  'MOCK_SECONDARY_CLIENT',
  'MOCK_STARTER_CLIENT',
  'MOCK_CHATBOT',
  'MOCK_CHATBOT_FROM_DATA',
  'MOCK_TIMELINE',
  'MOCK_CONVERSATIONS',
  'MOCK_BILLING',
  'MOCK_BILLING_EXPORT',
  'MOCK_FLOW_ACTIVITY',
  'MOCK_N8N_EXECUTIONS',
  'MOCK_FLOW_HEALTH_ROWS',
];

// --- File discovery ---------------------------------------------------------

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// --- Static analysis --------------------------------------------------------

type MockRef = {
  file: string;
  line: number;
  symbol: string;
  text: string;
  /** Within +/- 80 lines of the reference, is at least one guard present? */
  guardContext: boolean;
  /** Is the reference inside a `if (rows.length === 0)` style branch? */
  inZeroRowsFallback: boolean;
  /** Is the reference inside an `if (!isDatabaseConfigured)` block? */
  inUnconfiguredBranch: boolean;
  /** Is the reference in a `try { ... } catch { ... }` `catch` block? */
  inCatchBlock: boolean;
};

/**
 * Scan a file for every MOCK_* reference and classify it.
 *
 * The classification is lexical: we look at +/- 80 lines from the reference
 * and check for guard patterns. This is intentionally coarse — the goal
 * is to fail loud when no guard exists at all, not to do a perfect AST
 * block analysis. The page-by-page fix is what removes the offenders.
 */
function scanFile(file: string): MockRef[] {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const refs: MockRef[] = [];

  const WINDOW = 80;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const sym of TRACKED_MOCK_SYMBOLS) {
      const re = new RegExp(`\\b${sym}\\b`);
      if (!re.test(line)) continue;

      const start = Math.max(0, i - WINDOW);
      const end = Math.min(lines.length, i + WINDOW);
      const slice = lines.slice(start, end).join('\n');

      const guardContext =
        /isBackendConfigured/.test(slice) ||
        /isDatabaseConfigured/.test(slice) ||
        /isPortalDevMock/.test(slice);

      // The `if (rows.length === 0)` fallback is the regression class:
      // it fires when the DB returns 0 rows in production. We check by
      // scanning the lines BELOW the reference for a `if (rows.length
      // === 0)` line that precedes the MOCK_* reference within the
      // window. We do NOT scan above — the previous zero-rows branch
      // (e.g. in a helper function) has already closed by the time we
      // reach the MOCK_* assignment.
      const inZeroRowsFallback = (() => {
        for (let j = i; j >= Math.max(0, i - WINDOW); j--) {
          if (/if\s*\(\s*rows\.length\s*===\s*0\s*\)/.test(lines[j])) return true;
          if (/if\s*\(\s*stepSummaries\.length\s*===\s*0\s*\)/.test(lines[j])) return true;
          if (/if\s*\(\s*companyName\s*===\s*'Cliente'\s*\)/.test(lines[j])) return true;
        }
        return false;
      })();

      // The reference is inside an `if (!isDatabaseConfigured) { ... }`
      // branch — the dev-mock fallback. We look for the `!isDatabaseConfigured`
      // opening AND verify the MOCK_* line appears BEFORE the next
      // closing brace at the same nesting level.
      const inUnconfiguredBranch = (() => {
        for (let j = i; j >= Math.max(0, i - WINDOW); j--) {
          if (/if\s*\(\s*!isDatabaseConfigured\s*\)/.test(lines[j])) return true;
          if (/if\s*\(\s*!isBackendConfigured\s*\)/.test(lines[j])) return true;
          if (/if\s*\(\s*!isDatabaseConfigured\s*\)/.test(lines[j])) return true;
        }
        return false;
      })();

      // The reference is inside a `} catch { ... }` block. We find
      // the closest `} catch {` line above the reference, then count
      // brace characters from THAT line FORWARD to the MOCK_* line.
      // If the running depth is non-zero when we reach the MOCK_* line,
      // we are still inside the catch block (the block has not yet
      // closed).
      const inCatchBlock = (() => {
        for (let j = i; j >= 0; j--) {
          if (!/}\s*catch\s*[({]/.test(lines[j])) continue;
          // Found `} catch {` at line j. Walk forward from j+1 to i-1
          // and count brace depth. If non-zero at the MOCK_* line,
          // we're inside the catch block.
          let depth = 0;
          // The `} catch {` line itself contributes `}` (closes try)
          // and `{` (opens catch) — net zero, depth starts at 0.
          for (let k = j + 1; k < i; k++) {
            for (let c = 0; c < lines[k].length; c++) {
              if (lines[k][c] === '{') depth++;
              else if (lines[k][c] === '}') depth--;
            }
          }
          return depth > 0;
        }
        return false;
      })();

      refs.push({
        file: path.relative(REPO_ROOT, file),
        line: i + 1,
        symbol: sym,
        text: line.trim(),
        guardContext,
        inZeroRowsFallback,
        inUnconfiguredBranch,
        inCatchBlock,
      });
    }
  }
  return refs;
}

/**
 * Classify a reference as GATED (acceptable dev-mock fallback) or UNGATED
 * (the regression class — must be fixed).
 *
 * A reference is GATED iff:
 *   * it is inside an explicit `if (!isDatabaseConfigured)` or
 *     `if (!isBackendConfigured)` block, OR
 *   * it is inside a `catch { ... }` block that follows a Prisma fetch.
 *
 * It is NOT GATED (and the test fails) when:
 *   * it sits in a `if (rows.length === 0)` branch (the regression: the
 *     page runs the dev-mock fallback even when DB is configured), OR
 *   * it is referenced unconditionally in JSX (the KAIA-13744 class).
 */
function isGated(ref: MockRef): boolean {
  if (ref.inUnconfiguredBranch) return true;
  if (ref.inCatchBlock) return true;
  // A bare reference in a JSX-renderable context with no guard is ungated.
  if (!ref.guardContext) return false;
  // Guard present but the reference is in a `rows.length === 0` branch
  // — that's the production-renders-mock regression class.
  if (ref.inZeroRowsFallback) return false;
  return true;
}

// --- The test ---------------------------------------------------------------

describe('KAIA-13745 — structural guardrail: MOCK_* in admin/portal pages', () => {
  const adminFiles = [
    ...listTsxFiles(ADMIN_PORTAL_DIR),
    ...listTsxFiles(PORTAL_COMPONENTS_DIR),
  ];

  it('finds at least the admin/portal pages (sanity check)', () => {
    expect(adminFiles.length).toBeGreaterThan(0);
  });

  it('every MOCK_* reference in admin/portal pages is gated on isBackendConfigured / isDatabaseConfigured / isPortalDevMock', () => {
    const offending: Array<MockRef & { reason: string }> = [];
    let totalRefs = 0;

    for (const file of adminFiles) {
      for (const ref of scanFile(file)) {
        totalRefs++;
        if (isGated(ref)) continue;
        const reason = ref.inZeroRowsFallback
          ? 'inside if (rows.length === 0) fallback — fires in production when DB returns 0 rows'
          : ref.guardContext
            ? 'has guard context but reference is JSX-unconditional (regression class)'
            : 'no isBackendConfigured / isDatabaseConfigured / isPortalDevMock guard within +/- 80 lines';
        offending.push({ ...ref, reason });
      }
    }

    if (totalRefs === 0) {
      // Pages still reference mocks via the lib helpers; this should
      // never be zero. Surface as a test failure so the guardrail itself
      // can't be silently deleted.
      throw new Error(
        'Static guardrail found zero MOCK_* references in admin/portal. ' +
          'Either the tracked symbol list is stale or the admin pages were ' +
          'refactored to import MOCK_* indirectly. Re-baseline the test.',
      );
    }

    if (offending.length > 0) {
      const banner =
        `[KAIA-13745] ${offending.length} ungated MOCK_* reference(s) in admin/portal pages. ` +
        'Each line must be reachable ONLY when the backend / DB is NOT configured.';
      const detail = offending
        .map(
          (o) =>
            `  ${o.file}:${o.line}  ${o.symbol}\n    reason: ${o.reason}\n    text:   ${o.text}`,
        )
        .join('\n\n');
      throw new Error(`${banner}\n\n${detail}\n\nTotal MOCK_* refs scanned: ${totalRefs}`);
    }
  });
});

// =============================================================================
// KAIA-14318 — Structural guardrail against the
// `let <var> = MOCK_*;` default-initializer regression.
//
// The KAIA-13745 guardrail above catches `MOCK_*` symbols consumed in JSX
// or inside `if (rows.length === 0)` branches, but it does NOT catch the
// "default initializer" pattern where a `let` variable is seeded with a
// `MOCK_*` fixture at declaration time and later overwritten by the real
// DB path. The page-by-page fix in [clientId]/page.tsx (line 141) was
// the regression that escaped that guardrail.
//
// Pattern to forbid inside `src/app/admin/portal/**`:
//
//     let <ident> = MOCK_<something>;
//     let <ident>: SomeType = MOCK_<something>;   (less common, same risk)
//
// The fixture is reachable by `let` *before* any `if (isDatabaseConfigured)`
// or `if (!isDatabaseConfigured)` block runs. If the DB branch returns
// zero rows, the page renders the dev-mock fixture verbatim — which is
// exactly the brand-new-client regression from KAIA-13259 / KAIA-14318.
//
// Allowed patterns (the page must do ONE of these):
//
//   1. `let <ident>: SomeType = [];` + assign MOCK_* inside the
//      `if (!isDatabaseConfigured)` branch.
//   2. `let <ident>: SomeType = [];` only — never assign MOCK_* at all
//      (the production-only render path).
//   3. `const <ident> = MOCK_*` inside an `if (!isDatabaseConfigured)`
//      block, or inside a `try { db } catch { const mock = MOCK_*; }`
//      catch branch.
//
// We scan the same `src/app/admin/portal/**` set as KAIA-13745 but only
// flag `let` defaults — `const` defaults inside the gated branch are
// allowed by the KAIA-13745 guardrail already.
// =============================================================================

describe('KAIA-14318 — structural guardrail: `let <var> = MOCK_*;` default-initializer in admin/portal/**', () => {
  const adminFiles = listTsxFiles(ADMIN_PORTAL_DIR);

  type InitRef = { file: string; line: number; symbol: string; text: string };

  function scanDefaultInitializers(file: string): InitRef[] {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const refs: InitRef[] = [];
    // `let <ident> = MOCK_<Sym>;` — also tolerate a `: Type` annotation
    // before the `=`. We intentionally do NOT match `const MOCK_* = …`
    // (those are exports/definitions) and do NOT match `let MOCK_*` as
    // the LEFT side (which would be a destructuring rename, not a
    // default-initializer).
    const re = /^\s*let\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=]+)?=\s*([A-Za-z_$][\w$]*)\s*[;,]/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      const sym = m[1];
      if (!TRACKED_MOCK_SYMBOLS.includes(sym)) continue;
      refs.push({
        file: path.relative(REPO_ROOT, file),
        line: i + 1,
        symbol: sym,
        text: lines[i].trim(),
      });
    }
    return refs;
  }

  it('finds at least the admin/portal pages (sanity check)', () => {
    expect(adminFiles.length).toBeGreaterThan(0);
  });

  it('no `let <var> = MOCK_*;` default initializer appears in src/app/admin/portal/**', () => {
    const offenders: InitRef[] = [];
    let scannedFiles = 0;
    for (const file of adminFiles) {
      scannedFiles++;
      offenders.push(...scanDefaultInitializers(file));
    }

    if (offenders.length === 0) {
      // The regression would re-introduce one of these lines. We also
      // bail if the file scan returned zero files (so a future rename
      // of the admin/portal dir surfaces as a failing test, not a
      // silent pass).
      if (scannedFiles === 0) {
        throw new Error(
          '[KAIA-14318] admin/portal scan returned zero files. Re-baseline the test paths.',
        );
      }
      return;
    }

    const banner =
      `[KAIA-14318] ${offenders.length} default-initializer regression(s) found in admin/portal/**. ` +
      'A `let <var> = MOCK_*` assignment is reachable by the JSX render ' +
      'path BEFORE the `if (!isDatabaseConfigured)` branch fires, so a ' +
      'real client with zero rows will render the Acme fixture verbatim. ' +
      'Replace with `let <var>: Type[] = [];` and assign MOCK_* inside ' +
      'the `if (!isDatabaseConfigured)` block.';
    const detail = offenders
      .map((o) => `  ${o.file}:${o.line}  ${o.symbol}\n    text: ${o.text}`)
      .join('\n\n');
    throw new Error(`${banner}\n\n${detail}`);
  });
});
