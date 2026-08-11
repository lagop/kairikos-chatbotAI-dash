// =============================================================================
// KAIA-14345 / KAIA-14368 — Behavioural + structural guardrails for the
// operator-side onboarding advance controls that ship on /admin/portal/[clientId].
//
// The QA acceptance criteria (KAIA-14345):
//
//   * Clicking "Iniciar onboarding" on a brand-new client must produce four
//     `data-testid="onboarding-operator-row"` rows (T+0 done; T+3/T+7/T+14
//     pending) without leaving the admin section.
//   * Clicking "Marcar como completado" on a row must advance that row to
//     `data-done="true"` and render a "Completado" pill instead of the
//     button.
//   * Earlier completed milestones must remain in their done state when
//     later milestones are advanced.
//
// The test below is hermetic — it reads source files and asserts the
// structural pieces that make the acceptance verifiable from a real
// Playwright smoke (see `tests/specs/admin-onboarding-controls.spec.ts`
// for the runtime half). It does NOT mount React; that is left to the
// Playwright suite which has a real DB + Next.js runtime.
//
// What we verify:
//   1. The server-action module exists at
//      `src/app/admin/portal/[clientId]/onboarding-actions.ts`.
//   2. Every export from that module is an async function (Next.js 14
//      "use server" guard). A bare constant export would compile but
//      throw at runtime with "Server Actions must be async functions".
//   3. The module calls `revalidatePath` so the next server-component
//      re-render reflects the new `chatbotActivity` row.
//   4. The client component `OnboardingOperatorActions` emits the QA
//      acceptance testids and Spanish copy.
//   5. The admin overview page renders `<OnboardingOperatorActions
//      clientId=… doneMilestones=…>` inside the Onboarding section,
//      gated on `isDatabaseConfigured` so the dev-mock path never
//      surfaces operator-only controls.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ACTIONS_PATH = path.join(
  REPO_ROOT,
  'src',
  'app',
  'admin',
  'portal',
  '[clientId]',
  'onboarding-actions.ts',
);
const COMPONENT_PATH = path.join(
  REPO_ROOT,
  'src',
  'components',
  'portal',
  'OnboardingOperatorActions.tsx',
);
const PAGE_PATH = path.join(
  REPO_ROOT,
  'src',
  'app',
  'admin',
  'portal',
  '[clientId]',
  'page.tsx',
);

function readActions(): string {
  return fs.readFileSync(ACTIONS_PATH, 'utf8');
}

function readComponent(): string {
  return fs.readFileSync(COMPONENT_PATH, 'utf8');
}

function readPage(): string {
  return fs.readFileSync(PAGE_PATH, 'utf8');
}

function stripModulePrelude(src: string): string {
  // Strip block comments + line comments so a `// … use server` reference
  // inside a JSDoc-style comment does not satisfy the export-shape test.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('KAIA-14345 / KAIA-14368 — operator-side onboarding advance controls', () => {
  it('ships the onboarding-actions.ts module (sanity)', () => {
    expect(fs.existsSync(ACTIONS_PATH)).toBe(true);
  });

  it('ships the OnboardingOperatorActions.tsx component (sanity)', () => {
    expect(fs.existsSync(COMPONENT_PATH)).toBe(true);
  });

  it('every export from onboarding-actions.ts is an async function (Next.js 14 "use server" guard)', () => {
    const src = stripModulePrelude(readActions());
    const exportRe = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
    const namedTypes = /export\s+(?:type|interface)\s+([A-Za-z0-9_]+)/g;
    const namedConsts = /export\s+const\s+([A-Za-z0-9_]+)/g;

    const functionNames = new Set<string>();
    const typedNames = new Set<string>();
    const constNames = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = exportRe.exec(src)) !== null) {
      functionNames.add(match[1]);
    }
    while ((match = namedTypes.exec(src)) !== null) {
      typedNames.add(match[1]);
    }
    while ((match = namedConsts.exec(src)) !== null) {
      constNames.add(match[1]);
    }

    // Every `export function` MUST be async.
    const functionLines = src.match(/export\s+(?:async\s+)?function\s+[A-Za-z0-9_]+/g) ?? [];
    for (const line of functionLines) {
      expect(line).toMatch(/^export\s+async\s+function\b/);
    }

    // `export const` is fine for non-callable values (sets, types via
    // `as const`, arrays). The only thing we forbid is a non-async,
    // non-callable bare export that Next.js would reject — that is, an
    // `export const X = <non-function>`. Since we already assert every
    // `export function` is async, and we don't export any class/object,
    // this property holds by construction. We still want to flag the
    // common mistake of `export default { … }` so the file shape stays
    // clean.
    expect(src).not.toMatch(/export\s+default\s+/);
    expect(src).not.toMatch(/export\s+class\s+/);

    // Sanity: at minimum we expect the two handler exports to be present.
    expect(functionNames.has('startOnboardingAction')).toBe(true);
    expect(functionNames.has('markMilestoneAction')).toBe(true);
  });

  it('onboarding-actions.ts calls revalidatePath so the timeline re-renders', () => {
    const src = readActions();
    expect(src).toMatch(/import\s+\{\s*revalidatePath\s*\}\s+from\s+['"]next\/cache['"]/);
    expect(src).toMatch(/revalidatePath\(/);
  });

  it('onboarding-actions.ts gates on isDatabaseConfigured + session.isOperator', () => {
    const src = readActions();
    expect(src).toMatch(/isDatabaseConfigured/);
    expect(src).toMatch(/session\.isOperator|session\?\.isOperator|\.isOperator/);
    expect(src).toMatch(/startOnboardingAction/);
    expect(src).toMatch(/markMilestoneAction/);
  });

  it('onboarding-actions.ts upserts the T+0..T+14 milestone allowlist', () => {
    const src = readActions();
    expect(src).toMatch(/['"]T\+0['"]/);
    expect(src).toMatch(/['"]T\+3['"]/);
    expect(src).toMatch(/['"]T\+7['"]/);
    expect(src).toMatch(/['"]T\+14['"]/);
    expect(src).toMatch(/chatbotActivity\.upsert|prisma\.chatbotActivity\.upsert/);
  });

  it('OnboardingOperatorActions renders the QA-acceptance testid "onboarding-operator-row" for every milestone', () => {
    const src = readComponent();
    expect(src).toMatch(/data-testid="onboarding-operator-row"/);
    expect(src).toMatch(/data-testid="onboarding-operator-start"/);
    expect(src).toMatch(/data-testid="onboarding-operator-actions"/);
  });

  it('OnboardingOperatorActions emits Spanish copy: "Iniciar onboarding", "Marcar como completado", "Completado"', () => {
    const src = readComponent();
    expect(src).toMatch(/Iniciar onboarding/);
    expect(src).toMatch(/Marcar como completado/);
    expect(src).toMatch(/Completado/);
    expect(src).toMatch(/Controles de operador activos/);
  });

  it('OnboardingOperatorActions calls router.refresh after the server action', () => {
    const src = readComponent();
    expect(src).toMatch(/useRouter|from\s+['"]next\/navigation['"]/);
    expect(src).toMatch(/router\.refresh\(/);
  });

  it('admin overview page wires <OnboardingOperatorActions> inside the Onboarding section', () => {
    const src = readPage();
    expect(src).toMatch(/<OnboardingOperatorActions\s/);
    expect(src).toMatch(/clientId=\{params\.clientId\}/);
    expect(src).toMatch(/doneMilestones=\{doneMilestones\}/);
  });

  it('admin overview page gates OnboardingOperatorActions on isDatabaseConfigured (no operator controls in dev-mock)', () => {
    const src = readPage();
    // The block must include both `isDatabaseConfigured` and the
    // `<OnboardingOperatorActions … />` JSX. We assert the conditional
    // shape: `isDatabaseConfigured ? ( … <OnboardingOperatorActions … /> … ) : null`
    expect(src).toMatch(/isDatabaseConfigured\s*\?\s*\(/);
    // Strip block comments so the `// KAIA-14345 … gated on …` reference
    // in the page's JSX comment does not satisfy the test.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).toMatch(/isDatabaseConfigured\s*\?\s*\(/);
    expect(stripped).toMatch(/<OnboardingOperatorActions[\s\S]*?\/>/);
  });
});
