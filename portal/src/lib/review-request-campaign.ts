import 'server-only';
import type { GoogleBusinessConnection } from '@prisma/client';
import { prisma } from './prisma';
import { getValidAccessToken, fetchLocationReviewUrl } from './google-business';
import { logError } from './observability';

// =============================================================================
// WP-22b — review-request campaigns. AC: "la misma invitación se envía a
// todos los clientes por igual" — this file has no concept of a
// recipient's satisfaction or prior experience; every recipient in a
// campaign gets the exact same email. Review gating (asking first,
// routing only happy customers to the public review link) violates
// Google's policies and is structurally impossible to express here.
//
// Email sending mirrors wizard-recovery-email.ts: dynamic `require` for
// the Resend SDK (keeps it out of the Edge bundle), never throws, and
// returns a typed result so the caller can persist the outcome per
// ReviewRequest row instead of aborting a whole batch on one failure.
// =============================================================================

const FROM_ADDRESS =
  process.env.OPERATOR_NOTIFY_FROM ?? process.env.AUTH_EMAIL_FROM ?? 'Kairikos Ops <ops@kairikos.com>';
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';

export const MAX_RECIPIENTS_PER_CAMPAIGN = 200;

export const CONSENT_BASES = ['customer_relationship', 'explicit_consent'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export function isConsentBasis(value: string): value is ConsentBasis {
  return (CONSENT_BASES as readonly string[]).includes(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildReviewRequestEmail(vars: {
  recipientName: string | null;
  businessName: string;
  trackingUrl: string;
}): { subject: string; text: string; html: string } {
  const greetingName = vars.recipientName?.trim() || null;
  const subject = `¿Nos dejas una reseña? — ${vars.businessName}`;
  const greeting = greetingName ? `Hola ${greetingName},` : 'Hola,';
  const text = [
    greeting,
    '',
    `Gracias por confiar en ${vars.businessName}. Si tienes un minuto, nos ayudaría mucho que compartieras tu experiencia en una reseña de Google:`,
    '',
    vars.trackingUrl,
    '',
    'Gracias de nuevo.',
    `— ${vars.businessName}`,
  ].join('\n');
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>Gracias por confiar en ${escapeHtml(vars.businessName)}. Si tienes un minuto, nos ayudaría mucho que compartieras tu experiencia en una reseña de Google:</p>`,
    `<p><a href="${escapeHtml(vars.trackingUrl)}">Dejar una reseña</a></p>`,
    `<p>Gracias de nuevo.<br />— ${escapeHtml(vars.businessName)}</p>`,
  ].join('\n');
  return { subject, text, html };
}

export type SendReviewRequestEmailResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

export async function sendReviewRequestEmail(input: {
  to: string;
  recipientName: string | null;
  businessName: string;
  trackingUrl: string;
}): Promise<SendReviewRequestEmailResult> {
  if (!input.to || !input.to.includes('@')) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipient' };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  const rendered = buildReviewRequestEmail({
    recipientName: input.recipientName,
    businessName: input.businessName,
    trackingUrl: input.trackingUrl,
  });

  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);

  try {
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: [input.to],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export interface CampaignRecipientInput {
  email: string;
  name?: string | null;
}

export interface CreateCampaignInput {
  connection: GoogleBusinessConnection;
  businessName: string;
  campaignName: string;
  consentBasis: ConsentBasis;
  recipients: CampaignRecipientInput[];
}

export type CreateCampaignResult =
  | { ok: true; campaignId: string; sent: number; failed: number; skipped: number }
  | { ok: false; error: 'no_review_url' | 'no_recipients' };

/**
 * Ensures the connection's review link is cached, creates the campaign +
 * one ReviewRequest per (deduped) recipient, and sends each email
 * synchronously — acceptable for the capped recipient count
 * (MAX_RECIPIENTS_PER_CAMPAIGN) this route enforces. Each request's
 * status is persisted individually so a failure partway through never
 * loses track of what was actually sent.
 */
export async function createCampaignWithRequests(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const deduped = new Map<string, CampaignRecipientInput>();
  for (const r of input.recipients) {
    const email = r.email.trim().toLowerCase();
    if (email) deduped.set(email, { email, name: r.name ?? null });
  }
  if (deduped.size === 0) {
    return { ok: false, error: 'no_recipients' };
  }

  let reviewUrl = input.connection.reviewUrl;
  if (!reviewUrl) {
    const accessToken = await getValidAccessToken(input.connection);
    reviewUrl = accessToken
      ? await fetchLocationReviewUrl(accessToken, input.connection.locationId)
      : null;
    if (reviewUrl) {
      await prisma.googleBusinessConnection
        .update({ where: { id: input.connection.id }, data: { reviewUrl } })
        .catch(() => null);
    }
  }
  if (!reviewUrl) {
    return { ok: false, error: 'no_review_url' };
  }

  const campaign = await prisma.reviewRequestCampaign.create({
    data: {
      connectionId: input.connection.id,
      clientId: input.connection.clientId,
      tenantId: input.connection.tenantId,
      name: input.campaignName,
    },
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const recipient of deduped.values()) {
    const request = await prisma.reviewRequest.create({
      data: {
        campaignId: campaign.id,
        channel: 'email',
        recipient: recipient.email,
        recipientName: recipient.name,
        consentBasis: input.consentBasis,
        status: 'pending',
      },
    });

    const trackingUrl = `${PORTAL_BASE_URL}/r/${request.id}`;
    const result = await sendReviewRequestEmail({
      to: recipient.email,
      recipientName: recipient.name ?? null,
      businessName: input.businessName,
      trackingUrl,
    });

    if (result.ok && !('skipped' in result)) {
      sent += 1;
      await prisma.reviewRequest.update({
        where: { id: request.id },
        data: { status: 'sent', resendMessageId: result.messageId, sentAt: new Date() },
      });
    } else if (result.ok) {
      // Dev no-op (no RESEND_API_KEY) — recorded as sent so the flow is
      // demoable without a real key, matching wizard-recovery-email.ts's
      // "skipped" convention. sendError notes the reason for operator
      // visibility.
      skipped += 1;
      await prisma.reviewRequest.update({
        where: { id: request.id },
        data: { status: 'sent', sentAt: new Date(), sendError: `skipped:${result.reason}` },
      });
    } else {
      failed += 1;
      logError('review_request_campaign.send_failed', new Error(result.error), {
        route: 'lib/review-request-campaign.ts',
        clientId: input.connection.clientId,
        campaignId: campaign.id,
      });
      await prisma.reviewRequest.update({
        where: { id: request.id },
        data: { status: 'failed', sendError: result.error.slice(0, 500) },
      });
    }
  }

  return { ok: true, campaignId: campaign.id, sent, failed, skipped };
}

/**
 * Re-sends ONLY the requests currently in 'failed' status for a
 * campaign — the AC that a retry never re-sends an already-sent
 * invitation. Requires businessName (not stored on the campaign) to
 * build the email, same as creation.
 */
export async function retryFailedRequests(
  campaignId: string,
  businessName: string,
): Promise<{ retried: number; sent: number; failed: number }> {
  const failedRequests = await prisma.reviewRequest.findMany({
    where: { campaignId, status: 'failed' },
  });

  let sent = 0;
  let failed = 0;
  for (const request of failedRequests) {
    const trackingUrl = `${PORTAL_BASE_URL}/r/${request.id}`;
    const result = await sendReviewRequestEmail({
      to: request.recipient,
      recipientName: request.recipientName,
      businessName,
      trackingUrl,
    });
    if (result.ok) {
      sent += 1;
      await prisma.reviewRequest.update({
        where: { id: request.id },
        data: {
          status: 'sent',
          resendMessageId: 'skipped' in result ? null : result.messageId,
          sentAt: new Date(),
          sendError: 'skipped' in result ? `skipped:${result.reason}` : null,
        },
      });
    } else {
      failed += 1;
      await prisma.reviewRequest.update({
        where: { id: request.id },
        data: { sendError: result.error.slice(0, 500) },
      });
    }
  }

  return { retried: failedRequests.length, sent, failed };
}
