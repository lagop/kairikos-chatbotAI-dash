// =============================================================================
// KAIA-1062 — shared action handlers for the client self-service endpoints.
//
// The /api/portal/onboarding route and the subroutes
// /api/portal/onboarding/snooze and /api/portal/onboarding/go-live-ready
// share the same business logic. Extracting the handlers here keeps the
// validation, dedup, and notification side-effects in one place — and
// makes the row-isolation rule auditable in a single read.
//
// All exported handlers are pure: they take a resolved `clientId` (so
// the caller controls session resolution) and return a `NextResponse`.
// They never throw on bad input — they return a typed 4xx so the route
// can pass it through unchanged.
// =============================================================================

import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from './prisma';
import {
  resolveOperatorRecipients,
  sendOperatorNotification,
  utcDayKey,
} from './operator-notify';

export const ALLOWED_MILESTONES: ReadonlySet<string> = new Set(['T+0', 'T+3', 'T+7', 'T+14']);

// KAIA-14519 — extended for the wizard v1 state machine. The
// handleGoLiveReady flow only legitimately transitions from 'in-progress'
// to 'go-live-pending' (or dedupes when already pending), so the value
// is still useful for the early check below. The wider set lets future
// flows (config_complete → ready, request_revision while live →
// updating) share the same allowlist without a follow-up patch.
const ALLOWED_CLIENT_STATES: ReadonlySet<string> = new Set([
  'in-progress',
  'go-live-pending',
  'live',
  'ready',
  'updating',
]);

export const GO_LIVE_READY_KIND = 'go-live-ready';

export interface SnoozeInput {
  milestoneId: string;
  days: number;
}

export async function handleSnooze(
  clientId: string,
  input: SnoozeInput,
): Promise<NextResponse> {
  if (!ALLOWED_MILESTONES.has(input.milestoneId)) {
    return NextResponse.json(
      {
        error: 'bad_request',
        detail: `milestoneId must be one of ${[...ALLOWED_MILESTONES].join(', ')}`,
      },
      { status: 400 },
    );
  }
  // Cap the snooze at 1 day to prevent a client from indefinitely
  // stalling their own onboarding. The UI only sends 1, but a
  // hand-crafted request with `days: 365` would otherwise re-stamp
  // `completedAt` a year in the future. The cap is server-side so
  // the UI is honest.
  const requestedDays = typeof input.days === 'number' ? input.days : 1;
  const days = Math.max(0, Math.min(1, Math.trunc(requestedDays)));
  if (days === 0) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'days must be 1' },
      { status: 400 },
    );
  }

  if (isDatabaseConfigured) {
    // Row isolation: read the row, confirm it belongs to this client,
    // then update. We do NOT use `update({ where: { id, clientId } })`
    // because the unique key is `(clientId, milestone)` — findUnique
    // on that compound key gives the same guarantee more clearly.
    const existing = await prisma.chatbotActivity.findUnique({
      where: { clientId_milestone: { clientId, milestone: input.milestoneId } },
      select: { id: true, completedAt: true, notes: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'not_found', detail: 'milestone not found for this client' },
        { status: 404 },
      );
    }
    // Push `completedAt` back by `days`. Semantics:
    //   * If the milestone is currently `null` (not started) → no-op
    //     semantically, but we still append a snooze note so the
    //     activity log shows the client did this.
    //   * If it's already done → push the timestamp back so the
    //     timeline re-renders the step as "current" (overdue).
    //   * If it's already overdue (completedAt in the past) → push
    //     further back so the overdue badge stays accurate.
    const base = existing.completedAt ?? new Date();
    const pushed = new Date(base.getTime() - days * 24 * 60 * 60 * 1000);
    const snoozeNote = `Snooze +${days}d desde portal (${new Date().toISOString()})`;
    const updated = await prisma.chatbotActivity.update({
      where: { id: existing.id },
      data: {
        completedAt: pushed,
        notes: existing.notes ? `${existing.notes}\n${snoozeNote}` : snoozeNote,
      },
      select: { id: true, milestone: true, completedAt: true, notes: true },
    });
    return NextResponse.json({
      ok: true,
      activity: {
        id: updated.id,
        milestone: updated.milestone,
        completedAt: updated.completedAt?.toISOString() ?? null,
        notes: updated.notes ?? '',
      },
    });
  }

  // Mock-dev path. Return a synthetic updated row so the UI flow is
  // end-to-end exercisable in `npm run dev` without a database.
  return NextResponse.json({
    ok: true,
    activity: {
      id: `mock-${input.milestoneId}`,
      milestone: input.milestoneId,
      completedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      notes: 'Snooze simulado (sin base de datos).',
    },
  });
}

export async function handleGoLiveReady(
  clientId: string,
  _input: Record<string, never>,
): Promise<NextResponse> {
  if (isDatabaseConfigured) {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, companyName: true, state: true, goLiveAt: true },
    });
    if (!client) {
      return NextResponse.json(
        { error: 'not_found', detail: 'client not found' },
        { status: 404 },
      );
    }
    if (client.goLiveAt) {
      return NextResponse.json(
        {
          error: 'conflict',
          detail: 'client is already live; go-live-ready is a no-op',
        },
        { status: 409 },
      );
    }
    if (!ALLOWED_CLIENT_STATES.has(client.state)) {
      return NextResponse.json(
        {
          error: 'conflict',
          detail: `client state "${client.state}" is not eligible for go-live-ready`,
        },
        { status: 409 },
      );
    }
    if (client.state === 'go-live-pending') {
      return NextResponse.json(
        { ok: true, deduped: true, state: 'go-live-pending' },
        { status: 200 },
      );
    }
    if (client.state !== 'in-progress') {
      return NextResponse.json(
        {
          error: 'conflict',
          detail: `go-live-ready is only allowed from 'in-progress', got '${client.state}'`,
        },
        { status: 409 },
      );
    }
    // All prior milestones must be done for the go-live handoff to make
    // sense. If a milestone row is missing or still open, refuse with a
    // precise error so the UI can disable the button or show why.
    const requiredMilestones = ['T+0', 'T+3', 'T+7'] as const;
    const rows = await prisma.chatbotActivity.findMany({
      where: {
        clientId,
        milestone: { in: [...requiredMilestones] },
      },
      select: { milestone: true, completedAt: true },
    });
    const missing = requiredMilestones.filter(
      (m) => !rows.find((r) => r.milestone === m && r.completedAt),
    );
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: 'conflict',
          detail: `cannot go-live-ready: milestones incomplete: ${missing.join(', ')}`,
        },
        { status: 409 },
      );
    }
    // Dedup BEFORE the state update: a repeat click on the same UTC day
    // should neither flip the state nor re-email the operator. The
    // state was already 'go-live-pending' from the first click.
    const day = utcDayKey();
    const existing = await prisma.operatorNotification.findUnique({
      where: {
        clientId_kind_day: {
          clientId: client.id,
          kind: GO_LIVE_READY_KIND,
          day,
        },
      },
      select: { id: true, sentAt: true, resendMessageId: true },
    });
    if (existing) {
      return NextResponse.json({
        ok: true,
        deduped: true,
        state: 'go-live-pending',
        notify: {
          sent: !existing.resendMessageId ? false : true,
          resendMessageId: existing.resendMessageId,
          error: null,
        },
      });
    }

    const updated = await prisma.chatbotClient.update({
      where: { id: clientId },
      data: { state: 'go-live-pending' },
      select: { id: true, state: true },
    });

    const notify = await fireGoLiveReadyNotification(client);

    return NextResponse.json({
      ok: true,
      deduped: false,
      state: updated.state,
      notify,
    });
  }

  return NextResponse.json({
    ok: true,
    deduped: false,
    state: 'go-live-pending',
    notify: { sent: false, resendMessageId: null, error: null },
  });
}

interface NotifyResult {
  sent: boolean;
  resendMessageId: string | null;
  error: string | null;
}

async function fireGoLiveReadyNotification(client: {
  id: string;
  name: string;
  companyName: string | null;
}): Promise<NotifyResult> {
  const recipients = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);
  if (recipients.length === 0) {
    return { sent: false, resendMessageId: null, error: 'no_recipients' };
  }
  const clientDisplayName = client.companyName ?? client.name;
  const subject = `[Kairikos] Cliente listo para go-live: ${clientDisplayName}`;
  const portalUrl =
    process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
  const text = [
    'Hola,',
    '',
    `El cliente "${clientDisplayName}" (${client.id}) ha confirmado que está listo para salir a producción.`,
    '',
    'Acción: revisa el portal y confirma el go-live cuando termines la validación final.',
    `Portal: ${portalUrl}/admin/portal/clients`,
    '',
    '— Kairikos Portal',
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos Portal</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Cliente listo para go-live</h1>
    </div>
    <p>El cliente <strong>${escapeHtml(clientDisplayName)}</strong> (${escapeHtml(client.id)}) ha confirmado que está listo para salir a producción.</p>
    <p style="margin: 24px 0;"><a href="${escapeHtml(`${portalUrl}/admin/portal/clients`)}" style="color: #111827;">Abrir en el portal</a></p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">Esta alerta la envía el portal automáticamente cuando un cliente pulsa "Estoy listo para go-live".</p>
  </body>
</html>`;
  const sent = await sendOperatorNotification({
    kind: GO_LIVE_READY_KIND,
    to: recipients,
    subject,
    text,
    html,
  });
  if (!sent.ok) {
    return { sent: false, resendMessageId: null, error: sent.error };
  }
  // Persist the dedup row so a re-click on the same day collapses to
  // a no-op, mirroring the help-request dedup policy.
  const day = utcDayKey();
  await prisma.operatorNotification.upsert({
    where: {
      clientId_kind_day: {
        clientId: client.id,
        kind: GO_LIVE_READY_KIND,
        day,
      },
    },
    create: {
      clientId: client.id,
      kind: GO_LIVE_READY_KIND,
      day,
      subject,
      context: JSON.stringify({ state: 'go-live-pending' }),
      resendMessageId: sent.messageId,
      sentAt: new Date(),
    },
    update: {
      sentAt: new Date(),
    },
    select: { id: true },
  });
  return {
    sent: !('skipped' in sent),
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

export async function handleAssetsUploaded(
  clientId: string,
  input: { milestone?: string; notes?: string },
): Promise<NextResponse> {
  const milestone = input.milestone ?? 'T+3';
  const notes = input.notes ?? 'Marcado por el cliente desde el portal.';

  if (isDatabaseConfigured) {
    const existing = await prisma.chatbotActivity.findUnique({
      where: { clientId_milestone: { clientId, milestone } },
      select: { id: true, completedAt: true, notes: true },
    });

    const row = await prisma.chatbotActivity.upsert({
      where: { clientId_milestone: { clientId, milestone } },
      create: {
        clientId,
        milestone,
        completedAt: new Date(),
        notes,
      },
      update: existing?.completedAt
        ? { notes }
        : { completedAt: new Date(), notes },
      select: { id: true, milestone: true, completedAt: true, notes: true },
    });

    return NextResponse.json({
      ok: true,
      deduped: Boolean(existing?.completedAt),
      activity: {
        id: row.id,
        milestone: row.milestone,
        completedAt: row.completedAt?.toISOString() ?? null,
        notes: row.notes ?? '',
      },
    });
  }

  return NextResponse.json(
    { ok: true, deduped: false, mocked: true, milestone },
    { status: 200 },
  );
}
