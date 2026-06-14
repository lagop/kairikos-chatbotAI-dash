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

export type WizardReviewAction = 'approve' | 'request_revision';

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
  deactivatedStepIds: string[];
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

async function ensureClientExists(clientId: string, tx: Prisma.TransactionClient): Promise<void> {
  const client = await tx.chatbotClient.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) {
    throw new WizardReviewError({ code: 'client_not_found' });
  }
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
  return prisma.$transaction(async (tx) => {
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

      return {
        stepId: updated.id,
        version: updated.version,
        status: updated.status as 'approved' | 'needs_revision',
        activeForBot: updated.activeForBot,
        approvedByOperatorId: updated.approvedByOperatorId,
        approvedAt: updated.approvedAt,
        deactivatedStepIds,
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

    return {
      stepId: updated.id,
      version: updated.version,
      status: updated.status as 'approved' | 'needs_revision',
      activeForBot: updated.activeForBot,
      approvedByOperatorId: updated.approvedByOperatorId,
      approvedAt: updated.approvedAt,
      revisionComment: updated.revisionComment,
      deactivatedStepIds: [],
    };
  });
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
