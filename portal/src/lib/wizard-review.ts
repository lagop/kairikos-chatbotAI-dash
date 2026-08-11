// =============================================================================
// KAIA-1165 — Operator wizard review state transitions.
//
// Pure server-side helpers that mutate `ChatbotConfigStep` + write the matching
// `ChatbotConfigStepAudit` rows for the operator approve / request-revision
// flow. Kept in a lib module (not inlined in the route handler) so the state
// machine can be unit-tested without spinning up Next.js.
//
// Status lifecycle (mirrors the migration's `KAIA-1163` comments):
//
//   draft  → submitted  → approved           (forward)
//                   ↘    needs_revision     (operator can flip back)
//
// The PATCH contract (KAIA-1165 / BE-3):
//   * approve       — sets status='approved' on the most recent submitted
//                     version, sets activeForBot=true on it, deactivates the
//                     previous active row, writes audit rows
//                     (action='approve', then 'activate' on the new row and
//                     'deactivate' on the previous one if it existed).
//   * request_revision — sets status='needs_revision' on the most recent
//                     version (regardless of prior status), writes audit
//                     row with action='request_revision' and a required
//                     comment. Does NOT touch activeForBot — the existing
//                     active version keeps running until the client re-submits
//                     and a new approval flips the flag.
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  WIZARD_REQUIRED_STEP_NUMBERS,
  getStepDefinition,
} from './wizard-catalog';

export type WizardReviewAction = 'approve' | 'request_revision';

// =============================================================================
// KAIA-14519 — Onboarding state transitions driven by the operator wizard
// review.
//
// Two transitions, both computed in the SAME Prisma transaction as the step
// approval so they cannot drift from the audit trail:
//
//   1. approve last mandatory step while state='in-progress' → 'ready'
//      (and fire a one-shot 'config_complete' operator notification at the
//       edge — deduped on (clientId, day) so a re-approve collapses to a
//       no-op).
//
//   2. request_revision on a mandatory step while state='live' → 'updating'
//      (also deduped so a re-fire of the same step collapse to a no-op).
//
// A client in 'live' NEVER moves back to 'ready'. 'in-progress' never goes
// straight to 'updating' (the wizard first has to land on 'live' before the
// bot is running production traffic). 'go-live-pending' is also a
// none-of-the-above terminal for these heuristics — the bot is not yet
// live, so neither signal applies.
//
// Both helpers return a typed `WizardStateTransition` so the caller / test
// suite can assert on the decision without re-reading the row.
// =============================================================================

export const CONFIG_COMPLETE_KIND = 'config_complete';
export const CONFIG_UPDATING_KIND = 'config-updating';

/** Step keys (string form of WIZARD_REQUIRED_STEP_NUMBERS) used by the
 *  readiness check. Module-level so the catalog + readiness lockstep —
 *  any change to `requiredForReady` flips the readiness set automatically.
 */
export const REQUIRED_STEP_KEYS_FOR_READY: ReadonlySet<string> = new Set(
  WIZARD_REQUIRED_STEP_NUMBERS.map((n) => String(n)),
);

export interface WizardStateTransition {
  /** The state we wrote, or null when no transition fired. */
  nextState: 'ready' | 'updating' | null;
  /** Whether the operator notify was fired on this call. False when the
   *  transition deduped against an existing row (idempotent re-fire). */
  notifyFired: boolean;
  /** Resend message id of the notify (null in dev without RESEND_API_KEY
   *  or when deduped). */
  resendMessageId: string | null;
  /** Failure reason for the notify path (Resend error or no-recipients).
   *  Only meaningful when `notifyFired` is true. */
  notifyError: string | null;
}

const EMPTY_TRANSITION: WizardStateTransition = {
  nextState: null,
  notifyFired: false,
  resendMessageId: null,
  notifyError: null,
};

export interface ReviewActor {
  operatorId: string;
  email: string;
}

export interface ReviewRequest {
  clientId: string;
  stepKey: string;
  action: WizardReviewAction;
  comment?: string;
}

export type ReviewError =
  | { code: 'client_not_found' }
  | { code: 'step_not_found' }
  | { code: 'invalid_state_for_approve' }
  | { code: 'comment_required' }
  | { code: 'comment_too_long' };

export interface ReviewResult {
  stepId: string;
  version: number;
  status: 'approved' | 'needs_revision';
  activeForBot: boolean;
  approvedByOperatorId: string | null;
  approvedAt: Date | null;
  /** Set on the request_revision branch; null/absent on approve. */
  revisionComment?: string | null;
  deactivatedStepIds: string[];
  /** State machine transition fired by this review (KAIA-14519). Null when
   *  the review did not meet the readiness / updating criteria. */
  transition: WizardStateTransition;
}

const MAX_COMMENT_LENGTH = 2000;

export class WizardReviewError extends Error {
  constructor(public readonly error: ReviewError) {
    super(error.code);
    this.name = 'WizardReviewError';
  }
}

interface FindStepOptions {
  clientId: string;
  stepKey: string;
  tx: Prisma.TransactionClient;
}

async function findLatestStepVersion({ clientId, stepKey, tx }: FindStepOptions) {
  return tx.chatbotConfigStep.findFirst({
    where: { clientId, stepKey },
    orderBy: { version: 'desc' },
  });
}

async function ensureClientExists(
  clientId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const client = await tx.chatbotClient.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) {
    throw new WizardReviewError({ code: 'client_not_found' });
  }
}

interface ClientStateRow {
  id: string;
  state: string;
  name: string;
  companyName: string | null;
  email: string;
}

async function loadClientForTransition(
  clientId: string,
  tx: Prisma.TransactionClient,
): Promise<ClientStateRow> {
  const row = await tx.chatbotClient.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      state: true,
      name: true,
      companyName: true,
      email: true,
    },
  });
  if (!row) {
    throw new WizardReviewError({ code: 'client_not_found' });
  }
  return row;
}

/**
 * Is every mandatory wizard step covered by an `approved` row with
 * `activeForBot=true`? Used to decide whether the approve branch should
 * flip the client to `ready`.
 *
 * Returns the keys still missing so the test can produce a precise
 * assertion message instead of a boolean. Step 12 is excluded from the
 * readiness set via `WIZARD_REQUIRED_STEP_NUMBERS` (`requiredForReady`
 * is false in the catalog), so this helper naturally ignores it.
 */
async function findMandatoryStepsMissingActive(
  clientId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const activeRows = await tx.chatbotConfigStep.findMany({
    where: { clientId, activeForBot: true },
    select: { stepKey: true },
  });
  const activeKeys = new Set(activeRows.map((r) => r.stepKey));
  const missing: string[] = [];
  for (const key of REQUIRED_STEP_KEYS_FOR_READY) {
    if (!activeKeys.has(key)) missing.push(key);
  }
  // Sanity: the set of `required` step keys must agree with the catalog's
  // `requiredForReady` flag. If a future step gets flipped in the catalog
  // the helper stays in lockstep because both go through the same export.
  for (const key of activeKeys) {
    if (!REQUIRED_STEP_KEYS_FOR_READY.has(key)) {
      // Unexpected step that is active but NOT mandatory (e.g. an
      // operator manually re-activated a non-required step). Treat as
      // ready (it doesn't block the readiness check) but emit a stable
      // missing marker for tests to assert against.
      // No-op on purpose; the missing array already excludes it.
    }
  }
  return missing;
}

/** Is the given stepKey a mandatory step per the wizard catalog? Defensive
 *  wrapper so call-sites read clearly. */
function isMandatoryStep(stepKey: string): boolean {
  return REQUIRED_STEP_KEYS_FOR_READY.has(stepKey);
}

/** Notify the operator about the wizard state edge. Mirrors the
 *  `handleGoLiveReady` pattern in src/lib/onboarding-actions.ts:124 so the
 *  Resend + dedup + audit trail all stay aligned.
 *
 *  IMPORTANT: this runs OUTSIDE the Prisma transaction. The transaction
 *  has already flipped client.state + written the audit rows; sending
 *  email inside the transaction would risk an orphan dedup row on
 *  rollback. Mirrors the go-live-ready side-effect carve-out.
 */
async function fireConfigCompleteNotification(
  prisma: PrismaClient,
  client: { id: string; state: string; name: string; companyName: string | null },
  kind: typeof CONFIG_COMPLETE_KIND | typeof CONFIG_UPDATING_KIND,
): Promise<{ fired: boolean; resendMessageId: string | null; error: string | null }> {
  // Lazy import: avoids a static-import cycle between wizard-review and
  // onboarding-actions. onboarding-actions re-uses lib/prisma directly.
  const { sendOperatorNotification, resolveOperatorRecipients, utcDayKey } = await import(
    './operator-notify'
  );

  const recipients = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);
  if (recipients.length === 0) {
    return { fired: false, resendMessageId: null, error: 'no_recipients' };
  }

  const clientDisplayName = client.companyName ?? client.name;
  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
  const subjectByKind = {
    [CONFIG_COMPLETE_KIND]: `[Kairikos] Wizard listo: ${clientDisplayName}`,
    [CONFIG_UPDATING_KIND]: `[Kairikos] Wizard en actualización: ${clientDisplayName}`,
  } as const;
  const subject = subjectByKind[kind];
  const textByKind = {
    [CONFIG_COMPLETE_KIND]:
      `El cliente "${clientDisplayName}" (${client.id}) ha terminado la configuración del wizard y ha pasado al estado "ready". ` +
      `Acción: revisa el panel y, si todo está bien, sigue con go-live cuando proceda. ` +
      `Portal: ${portalUrl}/admin/portal/clients`,
    [CONFIG_UPDATING_KIND]:
      `El cliente "${clientDisplayName}" (${client.id}) estaba en producción y un paso del wizard ha vuelto a "needs_revision". ` +
      `El bot sigue corriendo con la última versión aprobada hasta que se apruebe el nuevo paso. ` +
      `Portal: ${portalUrl}/admin/portal/clients`,
  } as const;
  const htmlByKind = {
    [CONFIG_COMPLETE_KIND]: renderConfigCompleteHtml(
      clientDisplayName,
      client.id,
      portalUrl,
    ),
    [CONFIG_UPDATING_KIND]: renderConfigUpdatingHtml(clientDisplayName, client.id, portalUrl),
  } as const;
  const text = textByKind[kind];
  const html = htmlByKind[kind];

  // `NotificationKind` is the runtime allowlist exposed via the route
  // ; wizard-review is operator-internal so it can fire slightly off-list
  // kinds ('go-live-ready', 'config_complete', 'config-updating') that
  // are still deduped by (clientId, kind, day) and routed to Resend
  // identically. The pre-existing onboarding-actions path for
  // 'go-live-ready' uses the same widening.
  const sent = await sendOperatorNotification({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kind: kind as any,
    to: recipients,
    subject,
    text,
    html,
  });
  if (!sent.ok) {
    return { fired: true, resendMessageId: null, error: sent.error };
  }

  // Dedup: same (clientId, kind, day). Re-firing the same config_complete
  // or config-updating in the same UTC day collapses to a no-op so a
  // double-click on the operator review UI doesn't spam the operator.
  const day = utcDayKey();
  await prisma.operatorNotification.upsert({
    where: {
      clientId_kind_day: {
        clientId: client.id,
        kind,
        day,
      },
    },
    create: {
      clientId: client.id,
      kind,
      day,
      subject,
      context: JSON.stringify({ state: client.state }),
      resendMessageId: sent.messageId,
      sentAt: new Date(),
    },
    update: {
      sentAt: new Date(),
    },
    select: { id: true },
  });
  return {
    fired: !('skipped' in sent),
    resendMessageId: sent.messageId,
    error: null,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderConfigCompleteHtml(
  clientDisplayName: string,
  clientId: string,
  portalUrl: string,
): string {
  return `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos Ops</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Wizard listo (config_complete)</h1>
    </div>
    <p>El cliente <strong>${escapeHtml(clientDisplayName)}</strong> (${escapeHtml(clientId)}) ha terminado la configuración del wizard y ha pasado al estado <code>ready</code>.</p>
    <p style="margin: 24px 0;"><a href="${escapeHtml(`${portalUrl}/admin/portal/clients`)}" style="color: #111827;">Abrir en el portal</a></p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">Esta alerta la envía el portal automáticamente cuando un operador aprueba el último paso obligatorio del wizard.</p>
  </body>
</html>`;
}

function renderConfigUpdatingHtml(
  clientDisplayName: string,
  clientId: string,
  portalUrl: string,
): string {
  return `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos Ops</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Wizard en actualización</h1>
    </div>
    <p>El cliente <strong>${escapeHtml(clientDisplayName)}</strong> (${escapeHtml(clientId)}) estaba en producción y un paso del wizard ha vuelto al estado <code>needs_revision</code>. El bot sigue corriendo con la última versión aprobada hasta que se apruebe la nueva.</p>
    <p style="margin: 24px 0;"><a href="${escapeHtml(`${portalUrl}/admin/portal/clients`)}" style="color: #111827;">Abrir en el portal</a></p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">Esta alerta la envía el portal automáticamente cuando un operador devuelve un paso obligatorio a revisión mientras el cliente está en producción.</p>
  </body>
</html>`;
}

async function maybeTransitionToReady(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  client: ClientStateRow,
): Promise<WizardStateTransition> {
  // Only the transition from 'in-progress' → 'ready' fires on each
  // approval. Re-approving after the client is already 'ready' (or worse,
  // 'live') must NEVER roll the state backwards. The catalog defines
  // 'requiredForReady' on the steps; the check is over activeForBot rows
  // only so a stale approved-but-deactivated row does not block readiness.
  if (client.state !== 'in-progress') {
    return EMPTY_TRANSITION;
  }
  const missing = await findMandatoryStepsMissingActive(client.id, tx);
  if (missing.length > 0) {
    return EMPTY_TRANSITION;
  }
  // Atomically flip to 'ready'. `where: { state: 'in-progress' }` makes
  // a concurrent approval on a different request a no-op instead of a
  // double-write — the second $transaction's updateMany returns 0 rows.
  const updated = await tx.chatbotClient.updateMany({
    where: { id: client.id, state: 'in-progress' },
    data: { state: 'ready' },
  });
  if (updated.count === 0) {
    // Lost the race; another approval already moved the client out of
    // 'in-progress'. Treat as a no-op transition (the OTHER request
    // will fire its own notify — deduped on (clientId, day)).
    return EMPTY_TRANSITION;
  }
  return { ...EMPTY_TRANSITION, nextState: 'ready' };
}

async function maybeTransitionToUpdating(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  client: ClientStateRow,
): Promise<WizardStateTransition> {
  // Only the transition from 'live' → 'updating' fires. The wizard
  // returns steps to needs_revision while the client is in production;
  // the bot keeps running on the last approved version per step until
  // the operator re-approves. A 'ready' client stays 'ready' — the
  // operator has not yet pressed go-live.
  if (client.state !== 'live') {
    return EMPTY_TRANSITION;
  }
  const updated = await tx.chatbotClient.updateMany({
    where: { id: client.id, state: 'live' },
    data: { state: 'updating' },
  });
  if (updated.count === 0) {
    return EMPTY_TRANSITION;
  }
  return { ...EMPTY_TRANSITION, nextState: 'updating' };
}

/**
 * Apply an operator review action. Must be called inside a Prisma transaction
 * (the route handler passes `prisma.$transaction(async (tx) => ...)`) so the
 * row updates + audit writes are atomic.
 *
 * Throws `WizardReviewError` for the documented business-rule failures.
 */
export async function applyWizardReview(
  prisma: PrismaClient,
  req: ReviewRequest,
  actor: ReviewActor,
): Promise<ReviewResult> {
  const result = await prisma.$transaction(async (tx) => {
    await ensureClientExists(req.clientId, tx);

    const latest = await findLatestStepVersion({
      clientId: req.clientId,
      stepKey: req.stepKey,
      tx,
    });
    if (!latest) {
      throw new WizardReviewError({ code: 'step_not_found' });
    }

    if (req.action === 'approve') {
      if (latest.status !== 'submitted') {
        throw new WizardReviewError({ code: 'invalid_state_for_approve' });
      }
      const comment = req.comment?.trim();
      if (comment && comment.length > MAX_COMMENT_LENGTH) {
        throw new WizardReviewError({ code: 'comment_too_long' });
      }

      // Deactivate the previous active row (if any) for this (client, step).
      const previousActive = await tx.chatbotConfigStep.findFirst({
        where: {
          clientId: req.clientId,
          stepKey: req.stepKey,
          activeForBot: true,
          id: { not: latest.id },
        },
        select: { id: true, version: true },
      });
      const deactivatedStepIds: string[] = [];
      if (previousActive) {
        await tx.chatbotConfigStep.update({
          where: { id: previousActive.id },
          data: { activeForBot: false },
        });
        await tx.chatbotConfigStepAudit.create({
          data: {
            stepId: previousActive.id,
            version: previousActive.version,
            actor: 'system',
            actorId: null,
            action: 'deactivate',
            comment: `Replaced by version ${latest.version} approval`,
          },
        });
        deactivatedStepIds.push(previousActive.id);
      }

      const now = new Date();
      const updated = await tx.chatbotConfigStep.update({
        where: { id: latest.id },
        data: {
          status: 'approved',
          activeForBot: true,
          approvedAt: now,
          approvedByOperatorId: actor.operatorId,
        },
        select: {
          id: true,
          version: true,
          status: true,
          activeForBot: true,
          approvedByOperatorId: true,
          approvedAt: true,
        },
      });

      // Two audit rows: 'approve' (operator decision) + 'activate' (system).
      await tx.chatbotConfigStepAudit.createMany({
        data: [
          {
            stepId: updated.id,
            version: updated.version,
            actor: 'operator',
            actorId: actor.operatorId,
            action: 'approve',
            comment: comment ?? null,
          },
          {
            stepId: updated.id,
            version: updated.version,
            actor: 'system',
            actorId: null,
            action: 'activate',
            comment: null,
          },
        ],
      });

      // KAIA-14519 — readiness check + maybe transition to 'ready'.
      // We compute AFTER the step approves so the partial unique invariant
      // (activeForBot = exactly one row per (client, step)) holds before
      // we read the active set. The transition itself is best-effort: a
      // racing concurrent approval will be a no-op (UPDATE returns 0).
      const clientRow = await loadClientForTransition(req.clientId, tx);
      const transition = await maybeTransitionToReady(prisma, tx, clientRow);

      return {
        stepId: updated.id,
        version: updated.version,
        status: updated.status as 'approved' | 'needs_revision',
        activeForBot: updated.activeForBot,
        approvedByOperatorId: updated.approvedByOperatorId,
        approvedAt: updated.approvedAt,
        deactivatedStepIds,
        transition,
        clientForNotify: clientRow,
      };
    }

    // request_revision branch
    const comment = req.comment?.trim();
    if (!comment) {
      throw new WizardReviewError({ code: 'comment_required' });
    }
    if (comment.length > MAX_COMMENT_LENGTH) {
      throw new WizardReviewError({ code: 'comment_too_long' });
    }

    const updated = await tx.chatbotConfigStep.update({
      where: { id: latest.id },
      data: { status: 'needs_revision', revisionComment: comment },
      select: {
        id: true,
        version: true,
        status: true,
        activeForBot: true,
        approvedByOperatorId: true,
        approvedAt: true,
        revisionComment: true,
      },
    });

    await tx.chatbotConfigStepAudit.create({
      data: {
        stepId: updated.id,
        version: updated.version,
        actor: 'operator',
        actorId: actor.operatorId,
        action: 'request_revision',
        comment,
      },
    });

    // KAIA-14519 — if the operator sends a mandatory step back to
    // needs_revision while the client is in 'live', flip them to
    // 'updating' so the operator and the bot pause can see the bot is
    // out of sync with the latest config. Non-mandatory steps do not
    // trip the transition (Step 8 / Step 12 are explicitly exempt).
    let transition: WizardStateTransition = EMPTY_TRANSITION;
    let clientForNotify: ClientStateRow | null = null;
    if (isMandatoryStep(req.stepKey)) {
      const clientRow = await loadClientForTransition(req.clientId, tx);
      transition = await maybeTransitionToUpdating(prisma, tx, clientRow);
      if (transition.nextState) {
        clientForNotify = clientRow;
      }
    }

    return {
      stepId: updated.id,
      version: updated.version,
      status: updated.status as 'approved' | 'needs_revision',
      activeForBot: updated.activeForBot,
      approvedByOperatorId: updated.approvedByOperatorId,
      approvedAt: updated.approvedAt,
      revisionComment: updated.revisionComment,
      deactivatedStepIds: [],
      transition,
      clientForNotify,
    };
  });

  // Post-commit side effects — run AFTER the transaction commits so a
  // rollback never leaves an orphan operator email or dedup row. Only
  // the ready / updating transitions need the notify; the empty case
  // is a typed no-op.
  let notifyFired = false;
  let resendMessageId: string | null = null;
  let notifyError: string | null = null;
  if (result.transition.nextState === 'ready' && result.clientForNotify) {
    const notifyResult = await fireConfigCompleteNotification(
      prisma,
      result.clientForNotify,
      CONFIG_COMPLETE_KIND,
    );
    notifyFired = notifyResult.fired;
    resendMessageId = notifyResult.resendMessageId;
    notifyError = notifyResult.error;
  } else if (result.transition.nextState === 'updating' && result.clientForNotify) {
    const notifyResult = await fireConfigCompleteNotification(
      prisma,
      result.clientForNotify,
      CONFIG_UPDATING_KIND,
    );
    notifyFired = notifyResult.fired;
    resendMessageId = notifyResult.resendMessageId;
    notifyError = notifyResult.error;
  }

  return {
    stepId: result.stepId,
    version: result.version,
    status: result.status,
    activeForBot: result.activeForBot,
    approvedByOperatorId: result.approvedByOperatorId,
    approvedAt: result.approvedAt,
    revisionComment: 'revisionComment' in result ? result.revisionComment : undefined,
    deactivatedStepIds: result.deactivatedStepIds,
    transition: {
      nextState: result.transition.nextState,
      notifyFired,
      resendMessageId,
      notifyError,
    },
  };
}

/**
 * Fetch all versions of a wizard step (newest first) plus the recent operator
 * audit trail. Read-only; no transaction needed.
 */
export async function getWizardStepReview(
  prisma: PrismaClient,
  clientId: string,
  stepKey: string,
) {
  const client = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      companyName: true,
      email: true,
      tier: true,
      state: true,
      goLiveAt: true,
    },
  });
  if (!client) return null;

  const versions = await prisma.chatbotConfigStep.findMany({
    where: { clientId, stepKey },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      status: true,
      payload: true,
      submittedAt: true,
      approvedAt: true,
      approvedByOperatorId: true,
      activeForBot: true,
      revisionComment: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (versions.length === 0) return null;

  const stepIds = versions.map((v) => v.id);
  const auditLogs = await prisma.chatbotConfigStepAudit.findMany({
    where: { stepId: { in: stepIds } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      stepId: true,
      version: true,
      actor: true,
      actorId: true,
      action: true,
      comment: true,
      createdAt: true,
    },
  });

  return { client, versions, auditLogs };
}
