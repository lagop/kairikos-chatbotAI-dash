// =============================================================================
// n8n workflow export generator — KAIA-756
//
// Generates the four n8n workflow JSONs (T+0, T+3, T+7, T+14) that POST
// to the portal's new internal endpoint at
//   POST {PORTAL_API_URL}/api/internal/activity
// authenticated by the shared secret PORTAL_API_KEY.
//
// Each flow:
//   1. Receives a webhook trigger (or, for T+3/7/14, a schedule).
//   2. Resolves the client (CU id) from the payload (Tally / Stripe).
//   3. Sends the T+N email (Resend).
//   4. POSTs the activity row to the portal — idempotent upsert keyed on
//      (clientId, milestone). The portal's unique constraint is the
//      source of truth; n8n just retries on 5xx.
//   5. On any failure in steps 3 or 4, alerts the operator on Slack.
//
// Output: 4 files in this folder, importable as-is via
//   n8n → Workflows → Import from File.
//
// Run:    npx tsx automations/portal-internal-activity/build-flows.ts
// =============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Milestone = 'T+0' | 'T+3' | 'T+7' | 'T+14';

interface FlowSpec {
  milestone: Milestone;
  dayOffset: number;
  webhookPath: string;
  triggerType: 'webhook' | 'schedule';
  triggerDescription: string;
  emailSubject: string;
  emailTemplate: string;
  emailBody: string;
}

const FLOWS: FlowSpec[] = [
  {
    milestone: 'T+0',
    dayOffset: 0,
    webhookPath: 'kairikos-chatbot-t0-intake',
    triggerType: 'webhook',
    triggerDescription:
      'Tally intake webhook — fires when a new client submits the Chatbot IA intake form.',
    emailSubject: 'Welcome to Kairikos — let’s get your chatbot live',
    emailTemplate: 't-plus-0-intake-v1',
    emailBody:
      '¡Bienvenido/a! Te enviamos el acceso al portal y los próximos pasos del onboarding.',
  },
  {
    milestone: 'T+3',
    dayOffset: 3,
    webhookPath: 'kairikos-chatbot-t3-followup',
    triggerType: 'schedule',
    triggerDescription:
      'Daily schedule, fires once per row flagged with `nextRunAt <= now()`.',
    emailSubject: 'T+3 — ¿Cómo vas con la configuración?',
    emailTemplate: 't-plus-3-followup-v1',
    emailBody:
      'Comprobamos que el chatbot está en producción y revisamos las primeras conversaciones.',
  },
  {
    milestone: 'T+7',
    dayOffset: 7,
    webhookPath: 'kairikos-chatbot-t7-followup',
    triggerType: 'schedule',
    triggerDescription:
      'Daily schedule, fires once per row flagged with `nextRunAt <= now()`.',
    emailSubject: 'T+7 — Primera semana en producción',
    emailTemplate: 't-plus-7-followup-v1',
    emailBody:
      'Repasamos las métricas de la primera semana y dejamos el siguiente paso claro.',
  },
  {
    milestone: 'T+14',
    dayOffset: 14,
    webhookPath: 'kairikos-chatbot-t14-followup',
    triggerType: 'schedule',
    triggerDescription:
      'Daily schedule, fires once per row flagged with `nextRunAt <= now()`.',
    emailSubject: 'T+14 — Revisión y optimización',
    emailTemplate: 't-plus-14-followup-v1',
    emailBody:
      'Revisión de métricas, ajustes finos y formación al equipo.',
  },
];

function makeFlow(spec: FlowSpec): Record<string, unknown> {
  const m = spec.milestone.toLowerCase();
  const idPrefix = `kairikos-${m.replace('+', 'p')}`;
  const activityNotes = JSON.stringify({
    email_subject: spec.emailSubject,
    send_status: 'sent',
    provider: 'resend',
    email_message_id: '${{ $json.id }}',
    template: spec.emailTemplate,
    locale: 'es-ES',
  }).replace(/"/g, '\\"');

  return {
    name: `${spec.milestone} — Onboarding Email + Portal Activity (KAIA-756)`,
    nodes: [
      // ---- 1. Trigger ----------------------------------------------------------
      spec.triggerType === 'webhook'
        ? {
            id: `${idPrefix}-trigger`,
            name: `${spec.milestone} Trigger (Tally webhook)`,
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2,
            position: [250, 300],
            webhookId: spec.webhookPath,
            parameters: {
              httpMethod: 'POST',
              path: spec.webhookPath,
              responseMode: 'lastNode',
              responseData: {
                responseCode: 200,
                responseBody: '{"status":"ok"}',
                responseHeaders: {
                  values: [{ name: 'Content-Type', value: 'application/json' }],
                },
              },
              options: { rawBody: false },
            },
          }
        : {
            id: `${idPrefix}-trigger`,
            name: `${spec.milestone} Trigger (Schedule)`,
            type: 'n8n-nodes-base.scheduleTrigger',
            typeVersion: 1,
            position: [250, 300],
            parameters: {
              rule: {
                interval: [
                  {
                    field: 'cronExpression',
                    expression: '0 9 * * *',
                    // 09:00 Europe/Madrid (workflow timezone setting below).
                  },
                ],
              },
            },
          },

      // ---- 2. Verify webhook signature (HMAC-SHA256) ---------------------------
      {
        id: `${idPrefix}-verify`,
        name: 'Verify Webhook Signature',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [470, 300],
        parameters: {
          jsCode: [
            '// HMAC-SHA256 verification against N8N_WEBHOOK_SHARED_SECRET.',
            '// Tally signs its webhooks with a shared secret configured per-form.',
            'const crypto = require(\'crypto\');',
            'const secret = $env.N8N_WEBHOOK_SHARED_SECRET;',
            'if (!secret) { throw new Error(\'N8N_WEBHOOK_SHARED_SECRET not configured\'); }',
            'const sig = $input.first().headers[\'x-tally-signature\'] || $input.first().headers[\'x-webhook-signature\'] || \'\';',
            'const raw = $input.first().binary?.data?.data',
            '  ? Buffer.from($input.first().binary.data.data, \'base64\').toString(\'utf8\')',
            '  : JSON.stringify($input.first().json);',
            'const expected = crypto.createHmac(\'sha256\', secret).update(raw).digest(\'hex\');',
            'try {',
            '  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {',
            '    throw new Error(\'Invalid webhook signature\');',
            '  }',
            '} catch (e) {',
            '  // Length mismatch also throws — treat as invalid.',
            '  if (!(e instanceof Error && e.message.startsWith(\'Invalid\'))) {',
            '    throw new Error(\'Invalid webhook signature\');',
            '  }',
            '  throw e;',
            '}',
            'return [{ json: $input.first().json }];',
          ].join('\n'),
        },
      },

      // ---- 3. Resolve client (Tally intake → Prisma chatbotClient.id) ----------
      {
        id: `${idPrefix}-resolve`,
        name: 'Resolve Client (Prisma)',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [690, 300],
        parameters: {
          method: 'POST',
          url: `={{ $env.PORTAL_API_URL }}/api/internal/lookup-client`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              {
                name: 'X-Kairikos-Internal-Key',
                value: '={{ $env.PORTAL_API_KEY }}',
              },
              { name: 'Content-Type', value: 'application/json' },
            ],
          },
          sendBody: true,
          body: `={{ JSON.stringify({ email: $json.fields?.email || $json.email || $json.body?.fields?.email }) }}`,
          options: { timeout: 15000, retry: { maxTries: 3, waitBetween: 5000 } },
        },
      },

      // ---- 4. Send the T+N email via Resend -----------------------------------
      {
        id: `${idPrefix}-send-email`,
        name: `Send ${spec.milestone} Email (Resend)`,
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [910, 300],
        parameters: {
          method: 'POST',
          url: 'https://api.resend.com/emails',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'resendApi',
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
            ],
          },
          sendBody: true,
          bodyParameters: {
            parameters: [
              {
                name: 'from',
                value: 'Kairikos <hola@kairikos.com>',
              },
              {
                name: 'to',
                value: '={{ $json.contactEmail }}',
              },
              {
                name: 'subject',
                value: spec.emailSubject,
              },
              {
                name: 'template',
                value: spec.emailTemplate,
              },
              {
                name: 'data.company_name',
                value: '={{ $json.companyName }}',
              },
            ],
          },
          options: { timeout: 30000, retry: { maxTries: 3, waitBetween: 5000 } },
        },
      },

      // ---- 5. Write the activity row to the portal ----------------------------
      {
        id: `${idPrefix}-write-activity`,
        name: 'Write Activity to Portal',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [1130, 300],
        parameters: {
          method: 'POST',
          url: `={{ $env.PORTAL_API_URL }}/api/internal/activity`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              {
                name: 'X-Kairikos-Internal-Key',
                value: '={{ $env.PORTAL_API_KEY }}',
              },
              { name: 'Content-Type', value: 'application/json' },
            ],
          },
          sendBody: true,
          body: `={{ JSON.stringify({ clientId: $('Resolve Client (Prisma)').item.json.clientId, milestone: '${spec.milestone}', completedAt: new Date().toISOString(), notes: ${activityNotes} }) }}`,
          options: { timeout: 15000, retry: { maxTries: 3, waitBetween: 5000 } },
        },
      },

      // ---- 6. Slack alert on error (error branch) -----------------------------
      {
        id: `${idPrefix}-slack-err`,
        name: 'Notify Slack on Error',
        type: 'n8n-nodes-base.slack',
        typeVersion: 2,
        position: [910, 520],
        parameters: {
          channel: '#automation-alerts',
          text: `:rotating_light: ${spec.milestone} flow failed for client \`{{ $json.clientId || 'unknown' }}\` after 3 retries. Last error: {{ $json.error }}`,
          otherOptions: { includeLinkToWorkflow: true },
        },
      },
    ],
    connections: {
      [`${spec.milestone} Trigger ${spec.triggerType === 'webhook' ? '(Tally webhook)' : '(Schedule)'}`]: {
        main: [[{ node: 'Verify Webhook Signature', type: 'main', index: 0 }]],
      },
      'Verify Webhook Signature': {
        main: [[{ node: 'Resolve Client (Prisma)', type: 'main', index: 0 }]],
      },
      'Resolve Client (Prisma)': {
        main: [[{ node: `Send ${spec.milestone} Email (Resend)`, type: 'main', index: 0 }]],
        error: [[{ node: 'Notify Slack on Error', type: 'main', index: 0 }]],
      },
      [`Send ${spec.milestone} Email (Resend)`]: {
        main: [[{ node: 'Write Activity to Portal', type: 'main', index: 0 }]],
        error: [[{ node: 'Notify Slack on Error', type: 'main', index: 0 }]],
      },
      'Write Activity to Portal': {
        error: [[{ node: 'Notify Slack on Error', type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
      saveExecutionProgress: true,
      saveManualExecutions: true,
      timezone: 'Europe/Madrid',
    },
    staticData: null,
    meta: {
      template: 'kairikos-portal-internal-activity',
      templateVersion: '1.0',
      dayOffset: spec.dayOffset,
      milestone: spec.milestone,
      author: 'Automation Engineer',
      linkedIssue: 'KAIA-756',
      triggerDescription: spec.triggerDescription,
    },
    pinData: {},
  };
}

function main() {
  const outDir = resolve(__dirname);
  for (const spec of FLOWS) {
    const flow = makeFlow(spec);
    const file = resolve(outDir, `${spec.milestone.toLowerCase().replace('+', '-')}-portal.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(flow, null, 2) + '\n', 'utf8');
    console.log(`  wrote ${file}`);
  }
  console.log(`[build-flows] ${FLOWS.length} workflow(s) generated.`);
}

main();
