'use server';

import { revalidatePath } from 'next/cache';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';

// =============================================================================
// KAIA-14345 / KAIA-14368 — operator-side onboarding advance controls for the
// admin overview page at /admin/portal/[clientId].
//
// The page (`src/app/admin/portal/[clientId]/page.tsx`) reads the onboarding
// timeline from `prisma.chatbotActivity.findMany({ where: { clientId } })`,
// but there is no operator-side UI to *write* to that table for a brand-new
// client. Without these actions the operator cannot move a brand-new client
// through T+0/3/7 without leaving the admin section or hitting Supabase
// REST by hand — which is exactly the gap QA flagged.
//
// These handlers are the inline-controls path (option 2 in KAIA-14345):
// per-step "Marcar como completado" buttons. They are gated on
// `isDatabaseConfigured` + `session.isOperator`, both enforced server-side.
// After each write they call `revalidatePath('/admin/portal/[clientId]',
// 'page')` so the server component re-renders the new timeline shape on the
// next RSC fetch — which is what the QA acceptance criteria demand.
//
// The handlers return the upserted row shape so the client component can
// refresh without an extra round-trip; the page re-renders the full
// timeline from `prisma.chatbotActivity.findMany` after `revalidatePath`
// fires.
//
// Next.js 14 "use server" guard: every export from this module is an async
// function. A regression test in `tests/unit/admin-onboarding-actions.test.ts`
// asserts this property.
// =============================================================================

export type OnboardingMilestoneId = 'T+0' | 'T+3' | 'T+7' | 'T+14';

export const ONBOARDING_MILESTONES: ReadonlyArray<OnboardingMilestoneId> = [
  'T+0',
  'T+3',
  'T+7',
  'T+14',
];

const MILESTONE_NOTE_BASE: Record<OnboardingMilestoneId, string> = {
  'T+0': 'Inicio de onboarding marcado por el operador.',
  'T+3': 'Configuración inicial marcada por el operador.',
  'T+7': 'Puesta en producción marcada por el operador.',
  'T+14': 'Revisión y optimización marcadas por el operador.',
};

export interface OnboardingAdvanceRow {
  id: string;
  clientId: string;
  milestone: OnboardingMilestoneId;
  completedAt: string | null;
  notes: string | null;
}

export interface OnboardingAdvanceResult {
  ok: boolean;
  row: OnboardingAdvanceRow | null;
  error: string | null;
  detail: string | null;
}

interface OperatorAuthorization {
  ok: boolean;
  operatorId: string | null;
  email: string | null;
  error: string | null;
}

async function authorizeOperator(): Promise<OperatorAuthorization> {
  if (!isDatabaseConfigured) {
    return { ok: false, operatorId: null, email: null, error: 'database_not_configured' };
  }
  let session;
  try {
    session = await getSession();
  } catch {
    return { ok: false, operatorId: null, email: null, error: 'session_unavailable' };
  }
  if (!session.isOperator) {
    return { ok: false, operatorId: null, email: null, error: 'unauthorized' };
  }
  return {
    ok: true,
    operatorId: session.userId,
    email: session.email,
    error: null,
  };
}

function isMilestoneId(value: unknown): value is OnboardingMilestoneId {
  return (
    typeof value === 'string' &&
    (ONBOARDING_MILESTONES as ReadonlyArray<string>).includes(value)
  );
}

function rowToShape(row: {
  id: string;
  clientId: string;
  milestone: string;
  completedAt: Date | null;
  notes: string | null;
}): OnboardingAdvanceRow {
  return {
    id: row.id,
    clientId: row.clientId,
    milestone: row.milestone as OnboardingMilestoneId,
    completedAt: row.completedAt?.toISOString() ?? null,
    notes: row.notes,
  };
}

function invalidMilestoneResult(): OnboardingAdvanceResult {
  return {
    ok: false,
    row: null,
    error: 'bad_request',
    detail: `milestone must be one of ${ONBOARDING_MILESTONES.join(', ')}`,
  };
}

function clientNotFoundResult(): OnboardingAdvanceResult {
  return {
    ok: false,
    row: null,
    error: 'not_found',
    detail: 'no client row matches that id',
  };
}

async function resolveClientId(rawId: string): Promise<string | null> {
  const client = await prisma.chatbotClient.findUnique({
    where: { id: rawId },
    select: { id: true },
  });
  return client?.id ?? null;
}

// Start onboarding for a brand-new client with zero `chatbotActivity` rows.
// Creates the T+0 row with `completedAt = now()`. T+3/T+7/T+14 rows stay
// absent — the timeline component renders a `Marcar como completado` button
// for each missing milestone.
export async function startOnboardingAction(input: {
  clientId: string;
}): Promise<OnboardingAdvanceResult> {
  const auth = await authorizeOperator();
  if (!auth.ok) {
    return { ok: false, row: null, error: auth.error, detail: null };
  }
  if (typeof input?.clientId !== 'string' || !input.clientId) {
    return { ok: false, row: null, error: 'bad_request', detail: 'clientId is required' };
  }

  const resolvedClientId = await resolveClientId(input.clientId);
  if (!resolvedClientId) {
    return clientNotFoundResult();
  }

  const existing = await prisma.chatbotActivity.findUnique({
    where: { clientId_milestone: { clientId: resolvedClientId, milestone: 'T+0' } },
    select: { id: true, completedAt: true, notes: true },
  });

  const now = new Date();
  const row = await prisma.chatbotActivity.upsert({
    where: { clientId_milestone: { clientId: resolvedClientId, milestone: 'T+0' } },
    create: {
      clientId: resolvedClientId,
      milestone: 'T+0',
      completedAt: now,
      notes: MILESTONE_NOTE_BASE['T+0'],
    },
    update: existing?.completedAt
      ? {}
      : { completedAt: now, notes: MILESTONE_NOTE_BASE['T+0'] },
    select: { id: true, clientId: true, milestone: true, completedAt: true, notes: true },
  });

  revalidatePath(`/admin/portal/${resolvedClientId}`, 'page');

  return { ok: true, row: rowToShape(row), error: null, detail: null };
}

// Mark a milestone as completed. Idempotent — re-stamping a done milestone
// keeps the original `completedAt` and refreshes the operator note so the
// audit log shows who re-ran the action.
export async function markMilestoneAction(input: {
  clientId: string;
  milestone: OnboardingMilestoneId;
}): Promise<OnboardingAdvanceResult> {
  const auth = await authorizeOperator();
  if (!auth.ok) {
    return { ok: false, row: null, error: auth.error, detail: null };
  }
  if (typeof input?.clientId !== 'string' || !input.clientId) {
    return { ok: false, row: null, error: 'bad_request', detail: 'clientId is required' };
  }
  if (!isMilestoneId(input?.milestone)) {
    return invalidMilestoneResult();
  }
  const milestone = input.milestone;

  const resolvedClientId = await resolveClientId(input.clientId);
  if (!resolvedClientId) {
    return clientNotFoundResult();
  }

  const existing = await prisma.chatbotActivity.findUnique({
    where: { clientId_milestone: { clientId: resolvedClientId, milestone } },
    select: { id: true, completedAt: true, notes: true },
  });

  const now = new Date();
  const operatorTag = auth.email
    ? `Marcado por operador (${auth.email})`
    : 'Marcado por operador';
  const baseNote = MILESTONE_NOTE_BASE[milestone];
  const mergedNotes = existing?.notes
    ? `${existing.notes}\n${operatorTag} · ${now.toISOString()}`
    : `${baseNote}\n${operatorTag} · ${now.toISOString()}`;

  const row = await prisma.chatbotActivity.upsert({
    where: { clientId_milestone: { clientId: resolvedClientId, milestone } },
    create: {
      clientId: resolvedClientId,
      milestone,
      completedAt: now,
      notes: mergedNotes,
    },
    update: existing?.completedAt
      ? { notes: mergedNotes }
      : { completedAt: now, notes: mergedNotes },
    select: { id: true, clientId: true, milestone: true, completedAt: true, notes: true },
  });

  revalidatePath(`/admin/portal/${resolvedClientId}`, 'page');

  return { ok: true, row: rowToShape(row), error: null, detail: null };
}
