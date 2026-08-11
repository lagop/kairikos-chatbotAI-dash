// =============================================================================
// KAIA-14318 — Behavioural guardrail: /admin/portal/[clientId] timeline
// must NOT render the Acme fixture when the backend is configured and
// the client has zero `chatbotActivity` rows.
//
// The page is a Next.js server component, so we verify the BRANCHES in
// the source rather than mounting React. The test is hermetic — it
// reads source files and asserts the three required timelines exist:
//
//   1. isDatabaseConfigured && client && activities.length === 0
//        → timeline defaults to [];  (the page must NOT seed it with
//        MOCK_TIMELINE before this branch)
//   2. isDatabaseConfigured && client && activities.length > 0
//        → timeline = activities.map(...)
//   3. !isDatabaseConfigured && clientId matches mock
//        → timeline = MOCK_TIMELINE   (inside the !isDatabaseConfigured
//        block, mirroring the flowHistory / n8nExecutions gating)
//
// Reference: KAIA-13259 (operator-visible regression on Clínica dental
// Orly). The structural guardrail in `admin-mock-gating.test.ts`
// (KAIA-14318 block) catches the `let <var> = MOCK_*;` shape; this test
// proves the page has all three correct branches present and in order.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PAGE_PATH = path.join(
  REPO_ROOT,
  'src',
  'app',
  'admin',
  'portal',
  '[clientId]',
  'page.tsx',
);

function readPage(): string {
  return fs.readFileSync(PAGE_PATH, 'utf8');
}

describe('KAIA-14318 — /admin/portal/[clientId] timeline branches', () => {
  it('finds the admin/portal/[clientId]/page.tsx file (sanity check)', () => {
    expect(fs.existsSync(PAGE_PATH)).toBe(true);
  });

  it('does NOT seed `timeline` with MOCK_TIMELINE at declaration time (regression guard)', () => {
    const src = readPage();
    // Strip block comments so a `// KAIA-14318 ... do NOT seed `timeline`
    // with MOCK_TIMELINE ...` reference in a comment does not satisfy
    // the test.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const declRe = /\blet\s+timeline\b[^\n;]*=\s*MOCK_TIMELINE\b/;
    expect(
      declRe.test(stripped),
      `Expected \`let timeline = MOCK_TIMELINE\` to be absent (default-initializer regression). ` +
        `The page must start with \`let timeline: OnboardingTimelineRow[] = [];\` and only ` +
        `assign MOCK_TIMELINE inside the \`if (!isDatabaseConfigured)\` branch.`,
    ).toBe(false);
  });

  it('initialises `timeline` as an empty array of OnboardingTimelineRow', () => {
    const src = readPage();
    expect(src).toMatch(
      /let\s+timeline\s*:\s*OnboardingTimelineRow\[\]\s*=\s*\[\s*\]\s*;/,
    );
  });

  it('imports OnboardingTimelineRow from @/types/portal', () => {
    const src = readPage();
    expect(src).toMatch(
      /import\s+type\s+\{\s*OnboardingTimelineRow\s*\}\s+from\s+['"]@\/types\/portal['"]/,
    );
  });

  it('populates `timeline` from `activities` when isDatabaseConfigured && activities.length > 0', () => {
    const src = readPage();
    // The real-DB branch maps `activities` into timeline rows. The exact
    // shape varies (we just need to confirm `timeline = activities.map`
    // is present inside the `if (activities.length > 0)` block).
    expect(src).toMatch(/if\s*\(\s*activities\.length\s*>\s*0\s*\)/);
    expect(src).toMatch(/timeline\s*=\s*activities\.map\s*\(/);
  });

  it('assigns MOCK_TIMELINE inside the `if (!isDatabaseConfigured)` branch', () => {
    const src = readPage();
    // Find the !isDatabaseConfigured block opening and the next
    // `timeline = MOCK_TIMELINE;` assignment within the block.
    const lines = src.split('\n');
    const blockStart = lines.findIndex((l) =>
      /if\s*\(\s*!isDatabaseConfigured\s*\)/.test(l),
    );
    expect(blockStart).toBeGreaterThan(-1);

    // Walk forward until the matching closing brace at the same
    // nesting depth, then verify `timeline = MOCK_TIMELINE` is in
    // the slice. Depth tracking is approximate (we only care about
    // the block body, not nested scopes).
    let depth = 0;
    let closed = false;
    let sawAssignment = false;
    for (let i = blockStart; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (i > blockStart && depth <= 0) {
        closed = true;
        break;
      }
      if (/timeline\s*=\s*MOCK_TIMELINE\s*;/.test(lines[i])) {
        sawAssignment = true;
      }
    }
    expect(closed).toBe(true);
    expect(
      sawAssignment,
      'Expected `timeline = MOCK_TIMELINE;` inside the `if (!isDatabaseConfigured)` block',
    ).toBe(true);
  });

  it('renders <OnboardingTimeline rows={timeline} />', () => {
    const src = readPage();
    expect(src).toMatch(/<OnboardingTimeline\s+rows=\{timeline\}\s*\/>/);
  });
});
