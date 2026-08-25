import 'server-only';
import type { GoogleBusinessConnection } from '@prisma/client';
import { prisma } from './prisma';
import { getValidAccessToken, fetchLocationReviewUrl } from './google-business';
import { logError } from './observability';
import { sendTemplate } from './whatsapp-api';

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

// ---------------------------------------------------------------------------
// WP-XX (Fase 10) — channel dispatch.
//
// The schema comment on ReviewRequest.channel always said a new channel
// "needs no schema change", and it was right: the campaign, the tracking
// link at /r/{id}, the pending|sent|failed machine and the retry are all
// channel-agnostic. Exactly three things were hard-wired to email — the
// literal channel value, the send call, and an includes('@') guard — and
// these are those three, parameterised.
//
// WhatsApp is for the 'recall' pack, whose clients live in WhatsApp and
// never open a panel. The standalone reviews product keeps using email.
// Both send the SAME invitation to every recipient; nothing here can
// branch on who the recipient is.
// ---------------------------------------------------------------------------

export const REVIEW_CHANNELS = ['email', 'whatsapp'] as const;
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number];

/** The approved template that carries a review invitation. Its single
 *  body parameter is the business name; the tracking link rides in the
 *  template's dynamic URL button, because a raw URL in a body parameter
 *  renders as plain text and Meta flags it. */
export const REVIEW_TEMPLATE = { name: 'recall_review_request', languageCode: 'es' } as const;

export interface WhatsAppSenderCredentials {
  token: string;
  phoneNumberId: string;
}

/** Is this recipient addressable on the given channel at all? Replaces
 *  the old inline includes('@'), which silently made every channel an
 *  email channel. */
export function isAddressable(channel: ReviewChannel, recipient: string): boolean {
  const value = recipient.trim();
  if (channel === 'email') return value.includes('@');
  // E.164. Not a strict validator — Twilio gave us this number, so the
  // job here is to reject an empty or obviously-not-a-number string, not
  // to re-derive numbering plans.
  return /^\+?\d{6,15}$/.test(value.replace(/[\s-]/g, ''));
}

export type SendReviewRequestResult = SendReviewRequestEmailResult;

/**
 * Send one invitation on whichever channel the campaign uses.
 *
 * Returns the email path's result shape unchanged so the caller's
 * bookkeeping — including the "skipped" convention that keeps the flow
 * demoable without provider credentials — stays identical for both.
 */
export async function dispatchReviewRequest(
  channel: ReviewChannel,
  input: {
    to: string;
    recipientName: string | null;
    businessName: string;
    trackingUrl: string;
    /** The tail of trackingUrl, for the template button. */
    trackingSuffix?: string;
  },
  whatsapp?: WhatsAppSenderCredentials,
): Promise<SendReviewRequestResult> {
  if (channel === 'email') return sendReviewRequestEmail(input);

  if (!isAddressable('whatsapp', input.to)) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipient' };
  }
  if (!whatsapp) {
    // Mirrors the email path with no RESEND_API_KEY: a missing sender is
    // a configuration gap, not a failed send, and must not mark the
    // request 'failed' and invite a retry that cannot work either.
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  const result = await sendTemplate(whatsapp.token, whatsapp.phoneNumberId, input.to, {
    ...REVIEW_TEMPLATE,
    bodyParams: [input.businessName],
    buttonUrlSuffix: input.trackingSuffix ?? input.trackingUrl,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, messageId: result.data.messages?.[0]?.id ?? 'unknown' };
}

export interface CampaignRecipientInput {
  /** An email address or an E.164 number, depending on the campaign
   *  channel. Named for what it is rather than for one channel's idea
   *  of it — the old `email` field was the reason a WhatsApp recipient
   *  had nowhere to go. */
  recipient: string;
  name?: string | null;
}

export interface CreateCampaignInput {
  connection: GoogleBusinessConnection;
  businessName: string;
  campaignName: string;
  consentBasis: ConsentBasis;
  recipients: CampaignRecipientInput[];
  /** Defaults to 'email', so every existing caller is unchanged. */
  channel?: ReviewChannel;
  /** Required for a whatsapp campaign; ignored otherwise. */
  whatsapp?: WhatsAppSenderCredentials;
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
  const channel = input.channel ?? 'email';
  const deduped = new Map<string, CampaignRecipientInput>();
  for (const r of input.recipients) {
    // Lower-casing is right for an address and harmless for a number.
    const recipient = r.recipient.trim().toLowerCase();
    if (recipient) deduped.set(recipient, { recipient, name: r.name ?? null });
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
        channel,
        recipient: recipient.recipient,
        recipientName: recipient.name,
        consentBasis: input.consentBasis,
        status: 'pending',
      },
    });

    const trackingUrl = `${PORTAL_BASE_URL}/r/${request.id}`;
    const result = await dispatchReviewRequest(
      channel,
      {
        to: recipient.recipient,
        recipientName: recipient.name ?? null,
        businessName: input.businessName,
        trackingUrl,
        trackingSuffix: request.id,
      },
      input.whatsapp,
    );

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
  whatsapp?: WhatsAppSenderCredentials,
): Promise<{ retried: number; sent: number; failed: number }> {
  const failedRequests = await prisma.reviewRequest.findMany({
    where: { campaignId, status: 'failed' },
  });

  let sent = 0;
  let failed = 0;
  for (const request of failedRequests) {
    const trackingUrl = `${PORTAL_BASE_URL}/r/${request.id}`;
    // The row records which channel it was sent on, so a retry cannot
    // silently switch a WhatsApp invitation to email.
    const result = await dispatchReviewRequest(
      request.channel === 'whatsapp' ? 'whatsapp' : 'email',
      {
        to: request.recipient,
        recipientName: request.recipientName,
        businessName,
        trackingUrl,
        trackingSuffix: request.id,
      },
      whatsapp,
    );
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
