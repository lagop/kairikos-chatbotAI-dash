import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepPendingTranscriptions } from '@/lib/recall-transcription';
import { purgeExpiredRecordings } from '@/lib/recall-retention';
import { notifyStuckOnboardings } from '@/lib/recall-stuck-alerts';
import { sweepPendingNotifications } from '@/lib/recall-messaging';
import { sendDailyDigests, sweepReviewReminders } from '@/lib/recall-reviews';
import { sendMonthlyReports, rollUpUsage } from '@/lib/recall-reports';
import { syncTemplateStatuses, warnExpiringTokens } from '@/lib/whatsapp-health';
import { advanceSubscriptionsWithApprovedTemplates } from '@/lib/recall-templates';
import { resolveActiveTwilioCredentials } from '@/lib/twilio-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/recall-tick
 *
 * The single endpoint the `scheduler` container calls. Everything the
 * 'recall' product needs to happen on a schedule is dispatched from here.
 *
 * ONE endpoint rather than one per job, deliberately: the alternative is
 * a crontab with an entry per job, which means scheduling logic lives in
 * a shell file nobody can unit-test and everybody forgets to update when
 * a job is added. Here the caller is dumb — it ticks — and the
 * application decides what that tick implies, in TypeScript, under test.
 *
 * Every job must therefore be safe to call MORE OFTEN than its work
 * actually needs, because that is exactly what will happen. Each one
 * re-checks its own due-ness (the isDigestDue pattern from
 * conversation-digest.ts), so a coarse or missed tick delays work rather
 * than skipping it.
 *
 * Same auth as the three cron routes that predate this one:
 * `Authorization: Bearer <CRON_SECRET>`, failing closed when unset.
 *
 * Jobs run sequentially and each is isolated: one failing job reports its
 * error and the rest still run. A 200 with a `failed` entry is the normal
 * way a job reports trouble — the response is telemetry the scheduler
 * logs, not a control signal.
 */
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

type JobOutcome = { ok: true; result: unknown } | { ok: false; error: string };

async function runJob(name: string, fn: () => Promise<unknown>): Promise<JobOutcome> {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    logError('recall_tick.job_failed', err, { job: name });
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const twilioAuth = await resolveActiveTwilioCredentials();

  const jobs: Record<string, JobOutcome | { skipped: string }> = {};

  // 1. Retention. First on purpose: it is the one job with a legal
  //    deadline attached, and a tick that runs out of time should have
  //    spent it here rather than on a transcription backlog.
  jobs.purgeRecordings = twilioAuth
    ? await runJob('purgeRecordings', () => purgeExpiredRecordings(prisma, twilioAuth))
    : { skipped: 'twilio_not_configured' };

  // 2. Catch up anything the inline transcription path missed because
  //    Whisper was down or slow when the recording landed.
  jobs.transcriptions = await runJob('transcriptions', () =>
    sweepPendingTranscriptions(prisma, twilioAuth ? { auth: twilioAuth } : {}),
  );

  // 3. The outbound messages a missed call owes: one to the person who
  //    rang and one to the owner. This is the job the product is sold
  //    on, and the reason the tick cadence matters — the caller message
  //    waits 90 seconds deliberately, so "due" is a query answered here
  //    rather than a timer that would not survive a restart.
  jobs.notifications = await runJob('notifications', () => sweepPendingNotifications(prisma));

  // 4. The review half. The digest closes the owner's day and the
  //    reminder chases a link nobody opened; both re-check their own
  //    due-ness, so a coarse or missed tick delays them rather than
  //    skipping them.
  jobs.dailyDigests = await runJob('dailyDigests', () => sendDailyDigests(prisma));
  jobs.reviewReminders = await runJob('reviewReminders', () => sweepReviewReminders(prisma));

  // 5. The monthly report is what stops a client cancelling in month
  //    two: recovered calls are invisible by nature, so nothing tells
  //    him it worked unless we do. The roll-up beside it is not billing
  //    — the pack is flat rate — but the early warning that one client
  //    has stopped consuming like the others.
  jobs.monthlyReports = await runJob('monthlyReports', () => sendMonthlyReports(prisma));
  jobs.usageRollup = await runJob('usageRollup', () => rollUpUsage(prisma));

  // 6. Push stalled altas at an operator. Deduped per (client, day) by
  //    operator-notify, so running this every tick is safe.
  jobs.stuckAlerts = await runJob('stuckAlerts', () => notifyStuckOnboardings(prisma));

  // 7. Meta changes state without telling us. A token that dies at 60
  //    days and a template Meta paused for quality both fail silently —
  //    the product keeps looking fine until a client's messages stop
  //    arriving. These two jobs are how that gets noticed in advance.
  jobs.tokenExpiry = await runJob('tokenExpiry', () => warnExpiringTokens(prisma));
  jobs.templateSync = await runJob('templateSync', () => syncTemplateStatuses(prisma));
  // Reads what templateSync just wrote — must run after it, same tick,
  // so a client whose last template got approved this very minute
  // advances immediately rather than waiting for the next one.
  jobs.templateApproval = await runJob('templateApproval', () => advanceSubscriptionsWithApprovedTemplates(prisma));

  return NextResponse.json({ ok: true, jobs });
}
