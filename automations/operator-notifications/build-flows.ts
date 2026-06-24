// =============================================================================
// n8n workflow export generator — KAIA-1061 + KAIA-1073 + KAIA-1080
//
// Generates the three n8n workflow JSONs that POST to the portal's
// operator-notification endpoint at
//   POST {PORTAL_API_URL}/api/internal/notify-operator
// authenticated by the shared secret PORTAL_API_KEY.
//
// Three flows, three trigger paths:
//   1. `stuck.json`             — schedule trigger (cron hourly). Calls
//      /api/internal/lookup-client?email=<x> to resolve the client and
//      then queries the portal's ChatbotActivity rows to find any
//      client silent for >N hours. Sends `kind: "stuck"` to the portal.
//   2. `execution-failed.json`  — n8n "error trigger" attached to the
//      T+0/3/7/14 flows (KAIA-756) as a sibling workflow. Sends
//      `kind: "execution-failed"` with the n8n execution metadata.
//   3. `escalation.json`        — schedule trigger (daily 09:00 UTC).
//      Lists clients where the most recent activity milestone is T+7
//      and no escalation row exists, then sends `kind: "escalation"`.
//
// Each flow ends with:
//   * an `HTTP Request` node POSTing to `/api/internal/notify-operator`
//     (the portal handles dedup via (clientId, kind, day) unique
//     constraint and operator email resolution — n8n just sends the
//     trigger).
//   * a "Report Execution to Portal" `HTTP Request` node (KAIA-1073
//     + KAIA-1080) POSTing to `/api/internal/n8n-execution` so the
//     operator flow-health dashboard's `lastN8nStatus` reflects the
//     operator-notify run too. Wired to the `main` (success) AND
//     `error` (failure) branches of every prior node — auto-detects
//     success/failure from the presence of `$json.error`, reads
//     `$execution` for the n8n execution id + startedAt.
//
// Output: 3 files in this folder, importable as-is via
//   n8n → Workflows → Import from File.
//
// Run:    npx tsx automations/operator-notifications/build-flows.ts
// =============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Kind = 'stuck' | 'execution-failed' | 'escalation';

interface FlowSpec {
  kind: Kind;
  filename: string;
  webhookPath?: string;
  triggerType: 'schedule' | 'errorTrigger';
  triggerDescription: string;
  // The `milestone` field the n8n-execution callback writes to the
  // dashboard's `N8nExecution.milestone` column. For `stuck` it
  // reflects the milestone the client is stuck on (read from the
  // Build Notify Payload input). For `execution-failed` we don't
  // know which T+N fired, so it's null. For `escalation` it's T+7.
  milestoneHint: 'T+0' | 'T+3' | 'T+7' | 'T+14' | 'null';
}

const FLOWS: FlowSpec[] = [
  {
    kind: 'stuck',
    filename: 'stuck.json',
    triggerType: 'schedule',
    triggerDescription:
      'Hourly schedule. Queries the portal for clients with no activity in the last 24h and POSTs a `stuck` notification per client.',
    milestoneHint: 'T+0',
  },
  {
    kind: 'execution-failed',
    filename: 'execution-failed.json',
    triggerType: 'errorTrigger',
    triggerDescription:
      'Error trigger — sibling workflow linked to the T+0/3/7/14 flows. Fires when any n8n execution in this workspace fails.',
    milestoneHint: 'null',
  },
  {
    kind: 'escalation',
    filename: 'escalation.json',
    triggerType: 'schedule',
    triggerDescription:
      'Daily schedule at 09:00 UTC. Lists clients where the latest activity milestone is T+7 and no escalation has been recorded, then POSTs an `escalation` notification per client.',
    milestoneHint: 'T+7',
  },
];

function buildFlow(spec: FlowSpec): Record<string, unknown> {
  const idPrefix = `kairikos-notify-${spec.kind.replace(/[^a-z0-9]/g, '')}`;

  return {
    name: `Operator Notify — ${spec.kind} (KAIA-1061)`,
    nodes: [
      // ---- 1. Trigger --------------------------------------------------------
      spec.triggerType === 'schedule'
        ? {
            id: `${idPrefix}-trigger`,
            name: `${spec.kind} — Schedule`,
            type: 'n8n-nodes-base.scheduleTrigger',
            typeVersion: 1,
            position: [250, 300],
            parameters: {
              rule: {
                interval: [
                  spec.kind === 'stuck'
                    ? {
                        field: 'cronExpression',
                        expression: '0 * * * *', // hourly
                      }
                    : {
                        field: 'cronExpression',
                        expression: '0 9 * * *', // 09:00 UTC daily
                      },
                ],
              },
            },
          }
        : {
            id: `${idPrefix}-trigger`,
            name: `${spec.kind} — Error Trigger`,
            type: 'n8n-nodes-base.errorTrigger',
            typeVersion: 1,
            position: [250, 300],
            parameters: {},
          },

      // ---- 2. Build the notify-operator payload ------------------------------
      {
        id: `${idPrefix}-build-payload`,
        name: 'Build Notify Payload',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [470, 300],
        parameters: {
          jsCode: buildPayloadCode(spec.kind),
        },
      },

      // ---- 3. POST /api/internal/notify-operator ----------------------------
      {
        id: `${idPrefix}-send`,
        name: 'POST /api/internal/notify-operator',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [690, 300],
        parameters: {
          method: 'POST',
          url: `={{ $env.PORTAL_API_URL }}/api/internal/notify-operator`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              {
                name: 'Content-Type',
                value: 'application/json',
              },
              {
                name: 'X-Kairikos-Internal-Key',
                value: '={{ $env.PORTAL_API_KEY }}',
              },
            ],
          },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: `={{ JSON.stringify($json.payload) }}`,
          options: {
            timeout: 15000,
            response: {
              response: {
                neverError: true,
              },
            },
          },
        },
      },

      // ---- 4. Log the response (idempotent) ---------------------------------
      {
        id: `${idPrefix}-log`,
        name: 'Log Result',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [910, 300],
        parameters: {
          jsCode: [
            '// Surface the dedup / sent state in the workflow logs so the',
            '// operator can confirm via n8n that the alert reached the',
            '// portal. The portal persists the row regardless.',
            'const out = $input.first().json;',
            'const log = {',
            '  kind: out.kind,',
            '  clientId: out.clientId,',
            '  deduped: Boolean(out.deduped),',
            '  skipped: out.skipped,',
            '  resendMessageId: out.resendMessageId,',
            '  sentAt: out.sentAt,',
            '};',
            'console.log(`[notify-operator] ${JSON.stringify(log)}`);',
            'return [{ json: log }];',
          ].join('\n'),
        },
      },

      // ---- 5. Report execution to portal (KAIA-1073 / KAIA-1080) -------------
      // Fires on BOTH success and failure paths so the operator
      // flow-health dashboard's `lastN8nStatus` reflects the
      // operator-notify run too. Auto-detects success/failure from
      // the presence of `$json.error`; reads `$execution` for the
      // n8n execution id + startedAt; resolves `clientId` from the
      // Build Notify Payload input (which carries the per-item
      // clientId for stuck/escalation, or null for execution-failed).
      //
      // The `milestone` field is the spec's hint, but for `stuck` we
      // override it with the per-item milestone from the Build
      // Notify Payload (input.milestone) so each row reflects the
      // milestone the client is stuck on.
      {
        id: `${idPrefix}-report-execution`,
        name: 'Report Execution to Portal (KAIA-1073)',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [1130, 300],
        parameters: {
          method: 'POST',
          url: `={{ $env.PORTAL_API_URL }}/api/internal/n8n-execution`,
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
          body:
            spec.kind === 'stuck'
              ? `={{ JSON.stringify((() => { const exec = $execution; const startedAt = exec && exec.startedAt ? new Date(exec.startedAt).toISOString() : new Date().toISOString(); const finishedAt = new Date().toISOString(); const errObj = $json && $json.error; const isFailure = Boolean(errObj); const upstream = $('Build Notify Payload').item && $('Build Notify Payload').item.json; const payload = (upstream && upstream.payload) || {}; const clientId = payload.clientId || null; const milestone = payload.milestone || null; const code = isFailure ? (errObj.name || (errObj.httpCode ? 'HTTP_' + errObj.httpCode : 'WORKFLOW_ERROR')) : 'OK'; const message = isFailure ? String(errObj.message || errObj.description || 'unknown n8n error').slice(0, 4000) : null; return { id: String(exec.id), clientId, clientName: null, workflow: 'Operator Notify — stuck', milestone, status: isFailure ? 'failed' : 'success', startedAt, finishedAt, errorCode: isFailure ? String(code).slice(0, 100) : null, errorMessage: message }; })()) }}`
              : `={{ JSON.stringify((() => { const exec = $execution; const startedAt = exec && exec.startedAt ? new Date(exec.startedAt).toISOString() : new Date().toISOString(); const finishedAt = new Date().toISOString(); const errObj = $json && $json.error; const isFailure = Boolean(errObj); const upstream = $('Build Notify Payload').item && $('Build Notify Payload').item.json; const payload = (upstream && upstream.payload) || {}; const clientId = payload.clientId || null; const code = isFailure ? (errObj.name || (errObj.httpCode ? 'HTTP_' + errObj.httpCode : 'WORKFLOW_ERROR')) : 'OK'; const message = isFailure ? String(errObj.message || errObj.description || 'unknown n8n error').slice(0, 4000) : null; return { id: String(exec.id), clientId, clientName: null, workflow: 'Operator Notify — ${spec.kind}', milestone: ${spec.milestoneHint === 'null' ? 'null' : `'${spec.milestoneHint}'`}, status: isFailure ? 'failed' : 'success', startedAt, finishedAt, errorCode: isFailure ? String(code).slice(0, 100) : null, errorMessage: message }; })()) }}`,
          options: {
            timeout: 15000,
            retry: { maxTries: 3, waitBetween: 5000 },
            response: { response: { neverError: true } },
          },
        },
      },
    ],
    connections: {
      [`${idPrefix}-trigger`]: {
        main: [[{ node: `${idPrefix}-build-payload`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-build-payload`]: {
        main: [[{ node: `${idPrefix}-send`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-send`]: {
        main: [[{ node: `${idPrefix}-log`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-log`]: {
        main: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
    },
    staticData: null,
    tags: [{ name: 'kairikos' }, { name: 'operator-notify' }, { name: `kind:${spec.kind}` }],
    active: false,
    pinData: {},
    versionId: '1.1.0',
    meta: {
      templateCredsSetupCompleted: false,
      executionCaptureIssue: 'KAIA-1073',
      linkedIssue: 'KAIA-1061',
    },
  };
}

function buildPayloadCode(kind: Kind): string {
  if (kind === 'stuck') {
    return [
      '// Stuck-notification payload builder.',
      '// Input: a list of clients with no activity in the last 24h. The',
      '// upstream list-node would query the portal for `clients WHERE NOT',
      '// EXISTS (SELECT 1 FROM "ChatbotActivity" WHERE "ChatbotActivity"."clientId"',
      '// = "ChatbotClient"."id" AND "completedAt" > now() - interval \'24 hours\')`',
      '// and emit one item per stuck client. The code node runs once per',
      '// item and emits the notify-operator payload.',
      'const input = $input.first().json;',
      'return [{',
      '  json: {',
      '    payload: {',
      '      kind: \'stuck\',',
      '      clientId: input.clientId,',
      '      milestone: input.milestone || \'T+0\',',
      '      hoursSince: Math.max(0, Math.round(Number(input.hoursSince) || 24)),',
      '    },',
      '  },',
      '}];',
    ].join('\n');
  }
  if (kind === 'execution-failed') {
    return [
      '// Execution-failed payload builder.',
      '// Input: the n8n error trigger context, with `execution.id`,',
      '// `execution.name` (the workflow name), and the error stack. We',
      '// also try to resolve a clientId from the workflow context (most',
      '// T+N flows carry it in `clientId`); when it is missing we set',
      '// clientId: null so the route still accepts the notification as an',
      '// unassigned event.',
      'const ctx = $json;',
      'const exec = ctx.execution || {};',
      'const wf = ctx.workflow || {};',
      'const input = (ctx.input && ctx.input.first && ctx.input.first().json) || {};',
      'const clientId = input.clientId || null;',
      'const errorMessage = (ctx.error && (ctx.error.message || ctx.error.description))',
      '  || (exec.error && exec.error.message)',
      '  || \'unknown n8n error\';',
      'return [{',
      '  json: {',
      '    payload: {',
      '      kind: \'execution-failed\',',
      '      clientId,',
      '      executionId: String(exec.id || \'unknown\'),',
      '      workflowName: String(exec.name || wf.name || \'unknown workflow\'),',
      '      error: String(errorMessage).slice(0, 4000),',
      '    },',
      '  },',
      '}];',
    ].join('\n');
  }
  // escalation
  return [
    '// Escalation payload builder.',
    '// Input: a list of clients where the latest activity milestone is T+7',
    '// and no escalation has been recorded for them. Emits one',
    '// notify-operator payload per client.',
    'const input = $input.first().json;',
    'return [{',
    '  json: {',
    '    payload: {',
    '      kind: \'escalation\',',
    '      clientId: input.clientId,',
    '      reason: input.reason || \'T+7 follow-up overdue\',',
    '      status: input.status || null,',
    '    },',
    '  },',
    '}];',
  ].join('\n');
}

function main() {
  mkdirSync(__dirname, { recursive: true });
  for (const spec of FLOWS) {
    const flow = buildFlow(spec);
    const out = resolve(__dirname, spec.filename);
    writeFileSync(out, JSON.stringify(flow, null, 2));
    const nodeCount = Array.isArray(flow.nodes) ? flow.nodes.length : 0;
    console.log(`[build-flows] wrote ${spec.filename} (${nodeCount} nodes)`);
  }
  console.log('[build-flows] OK — 3 flows generated');
}

main();
