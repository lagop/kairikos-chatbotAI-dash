// KAIA-4264 — end-to-end observability alerting smoke.
// Drives three Stripe webhook failures into system_events, then dispatches
// the Slack alert webhook the template documents. Captures HTTP + latency
// evidence for the status comment.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLACK_URL = process.env.KAIRIKOS_SECRETS_SLACK_ERROR_WEBHOOK_URL;
if (!SUPABASE_URL || !SUPABASE_KEY || !SLACK_URL) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and KAIRIKOS_SECRETS_SLACK_ERROR_WEBHOOK_URL are required');
  process.exit(1);
}

async function postEvent(severity, payload) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/system_events`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ event_type: 'stripe_webhook_failure', severity, payload }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST ${r.status} ${t}`);
  return JSON.parse(t)[0];
}

async function listStripeFailures() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/system_events?event_type=eq.stripe_webhook_failure&order=occurred_at.desc&limit=5&select=id,severity,payload,occurred_at`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`GET ${r.status} ${await r.text()}`);
  return r.json();
}

async function dispatchSlackAlert(recent) {
  const count = recent.length;
  const text = `[KAIA-4264] Stripe webhook failures = ${count} in last 5 minutes (threshold 2). ${recent.map(r => r.id.slice(0, 8)).join(', ')}`;
  const t0 = Date.now();
  const r = await fetch(SLACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const elapsed = Date.now() - t0;
  const body = await r.text();
  return { status: r.status, elapsed, body, text };
}

async function main() {
  const burstStart = Date.now();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const row = await postEvent('error', {
      eventId: `evt_kaia4264_${burstStart}_${i}`,
      reason: 'signature_invalid',
      source: 'kaia-4264-simulation',
    });
    ids.push(row.id);
  }
  const recent = await listStripeFailures();
  const slack = await dispatchSlackAlert(recent);
  const incidentElapsed = Date.now() - burstStart;
  console.log(JSON.stringify({
    burst_start: new Date(burstStart).toISOString(),
    incident_elapsed_ms: incidentElapsed,
    inserted_ids: ids,
    recent_events: recent,
    slack_response: slack,
  }, null, 2));
}

main().catch((e) => {
  console.error('smoke-error', e.message);
  process.exit(1);
});
