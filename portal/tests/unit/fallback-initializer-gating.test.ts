// =============================================================================
// KAIA-14318 — Structural guardrail against `let <var> = MOCK_*;` default
// initializers in `src/app/admin/portal/**`.
//
// Root cause of the regression: `portal/src/app/admin/portal/[clientId]/page.tsx:141`
// declared `let timeline = MOCK_TIMELINE;` as the default initializer. The
// real-DB override only fired when `activities.length > 0`, so brand-new
// clients (no rows yet) rendered the Acme/Globex fixture verbatim. This is
// the "fallback-default-initializer pattern" — the audit guardrail in
// `admin-mock-gating.test.ts` catches *direct* MOCK_* literal references
// but does NOT catch this `let X = MOCK_X; if (X.length) X = ...` shape.
//
// This test is hermetic: it only reads source files, no Next.js runtime.
// Run: `npm run test:unit -- tests/unit/fallback-initializer-gating.test.ts`
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_PORTAL_DIR = path.join(REPO_ROOT, 'src', 'app', 'admin', 'portal');

const DEFAULT_INITIALIZER_RE =
  /^\s*let\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=][^;]*?=\s*(MOCK_[A-Z0-9_]+)/;

type Violation = {
  file: string;
  line: number;
  variable: string;
  symbol: string;
  text: string;
};

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

function scanFile(file: string): Violation[] {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEFAULT_INITIALIZER_RE);
    if (!m) continue;
    violations.push({
      file: path.relative(REPO_ROOT, file),
      line: i + 1,
      variable: m[1],
      symbol: m[2],
      text: lines[i].trim(),
    });
  }
  return violations;
}

describe('KAIA-14318 — `let <var> = MOCK_*;` default-initializer in admin/portal/**', () => {
  const adminFiles = listTsxFiles(ADMIN_PORTAL_DIR);

  it('discovers at least the admin/portal pages (sanity check)', () => {
    expect(adminFiles.length).toBeGreaterThan(0);
  });

  it('has no `let <var> = MOCK_*;` default-initializer patterns in admin/portal/**', () => {
    const all: Violation[] = [];
    for (const file of adminFiles) {
      for (const v of scanFile(file)) {
        all.push(v);
      }
    }

    if (all.length > 0) {
      const banner =
        `[KAIA-14318] ${all.length} default-initializer pattern(s) in admin/portal/**. ` +
        '`let <var> = MOCK_*;` shadows the real-DB path when DB rows are empty.';
      const detail = all
        .map(
          (v) =>
            `  ${v.file}:${v.line}  let ${v.variable} = ${v.symbol};\n    text: ${v.text}`,
        )
        .join('\n\n');
      throw new Error(`${banner}\n\n${detail}`);
    }

    expect(all).toEqual([]);
  });
});
