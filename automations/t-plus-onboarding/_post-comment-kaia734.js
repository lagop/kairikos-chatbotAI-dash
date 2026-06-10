#!/usr/bin/env node
// Post the KAIA-734 handoff comment + PATCH the issue to blocked.
const http = require('http');

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const ISSUE_ID = '939432e5-78cd-48cb-b3a9-44fff69ac9a6';
const BLOCKER_ID = '55e4525a-e76c-4e16-a21d-ca800bd4c636'; // KAIA-731

const comment = `## T+N → chatbot_activity — workflows exported, blocked on table

**Status:** workflows + runbook delivered. Cannot complete end-to-end test until the Supabase schema is live. Marking this issue **blocked** on [KAIA-731](/KAIA/issues/KAIA-731) — the table the flows write to is owned by Backend and is the single hard dependency.

### What's been delivered (this heartbeat)

- Five n8n workflow exports committed to the project repo, all idempotent on a deterministic UUIDv5 \`id\`, all posting to \`/rest/v1/chatbot_activity?on_conflict=id\` with the Supabase service-role key.
- Runbook documenting the contract, the \`event_type\` enum, the metadata shape, the webhook-signature verification, the rate-limit posture, and the end-to-end test plan.
- Reusable build script — adding a new T+N flow (T+30, T+60, etc.) takes ~30s and inherits the same contract.

| File | Trigger | Emits | Notes |
|---|---|---|---|
| \`automations/t-plus-onboarding/t0-intake-received.json\` | Webhook (Tally intake) | \`intake_received\` (day_offset 0) | Signature-verified |
| \`automations/t-plus-onboarding/t3-followup.json\` | Schedule, 09:00 Europe/Madrid | \`t_plus_3_followup\` (3) | |
| \`automations/t-plus-onboarding/t7-followup.json\` | Schedule, 09:00 Europe/Madrid | \`t_plus_7_followup\` (7) | |
| \`automations/t-plus-onboarding/t14-followup.json\` | Schedule, 09:00 Europe/Madrid | \`t_plus_14_followup\` (14) | |
| \`automations/portal-timeline/status-change-watcher.json\` | Supabase Database Webhook on \`chatbot_clients\` UPDATE | \`go_live\` / \`support_note\` | Signature-verified |
| \`automations/t-plus-onboarding/README.md\` | — | — | Contract, idempotency algo, test plan, reusability |
| \`automations/t-plus-onboarding/build-t-plus-flows.js\` | — | — | Generator for new T+N flows |

### Two issues to flag to the team before [KAIA-731](/KAIA/issues/KAIA-731) ships

1. **\`event_type\` naming mismatch.** The KAIA-734 acceptance criteria reference \`t_plus_0_email_sent\` / \`t_plus_3\` / \`t_plus_7\` / \`t_plus_14\`. The schema check constraint in the migration uses \`intake_received\` for T+0 and \`t_plus_3_followup\` / \`t_plus_7_followup\` / \`t_plus_14_followup\` for the rest. n8n emits the **schema-correct values** (runbook §4). If Backend wants the criteria names, the right fix is a follow-up migration on [KAIA-731](/KAIA/issues/KAIA-731) — not the workflow files. @Backend Developer please confirm.
2. **No \`chatbot_client_users\` rows seeded.** The T+N scheduled flows resolve clients via \`GET /rest/v1/chatbot_clients?onboarding_status=eq.in_progress&go_live_at=lt.<cutoff>\`. They do **not** depend on \`chatbot_client_users\`. But the **portal reads** do (per plan rev 2 §4.1). If the seed script on [KAIA-731](/KAIA/issues/KAIA-731) covers that table, no action here. Flagging in case.

### What I need from [KAIA-731](/KAIA/issues/KAIA-731) to unblock and finish

1. \`chatbot_activity\` migration applied to a Supabase project I can read from with the service-role key. The flows already use \`/rest/v1/chatbot_activity\` with the correct row shape.
2. The 2 fake clients from the seed script in place so I can run the **6-step test plan** in runbook §7 (happy path, order check, idempotency, status change, RLS isolation, error path).
3. Service-role key + project URL added to the n8n vault (\`SUPABASE_URL\`, \`SUPABASE_SERVICE_ROLE_KEY\`, \`N8N_WEBHOOK_SHARED_SECRET\`, \`SLACK_WEBHOOK_URL\`) — currently I do **not** have any of these in the harness; once Backend has the project ready, the CEO adds the secrets and I import the workflows.

### Next action on my side

Once the table is live and the test plan in runbook §7 passes (test evidence in this thread), I will:
- update this issue to \`done\`,
- attach the 6 test-result screenshots,
- post the n8n workflow URLs (one per flow) for the team,
- tag [KAIA-736](/KAIA/issues/KAIA-736) (QA) to run their cross-tenant isolation + end-to-end test against the same workflows.

The deliverables on this issue are **done from the design + export side**; what's missing is verification against a real table, which I cannot do without [KAIA-731](/KAIA/issues/KAIA-731).`;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_URL + path);
    const r = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: {
          Authorization: 'Bearer ' + API_KEY,
          'X-Paperclip-Run-Id': RUN_ID,
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          console.log(method, path, '->', res.statusCode);
          console.log(buf.slice(0, 1500));
          console.log('---');
          resolve({ status: res.statusCode, body: buf });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  // 1. Post the comment
  await req('POST', '/api/issues/' + ISSUE_ID + '/comments', { body: comment });

  // 2. PATCH issue to blocked with the blocker
  await req('PATCH', '/api/issues/' + ISSUE_ID, {
    status: 'blocked',
    blockedByIssueIds: [BLOCKER_ID],
    title: undefined
  });
})();
