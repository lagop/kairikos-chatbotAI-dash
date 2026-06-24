// =============================================================================
// n8n workflow export generator — KAIA-1172 / AU-2
//
// Generates the two n8n workflow JSONs that back the wizard-lifecycle
// triggers:
//   1. `wizard-abandoned.json`     — schedule trigger (cron every 6h). Calls
//      POST /api/internal/wizard-abandoned/scan to get the candidate list,
// //      then POST /api/internal/wizard-abandoned/fire per candidate to
//      send the Kira-voice recovery email and write a `wizard_abandoned`
//      ChatbotActivity row for the funnel view (KAIA-1170).
//   2. `config-review-overdue.json` — schedule trigger (cron every 1h).
//      Calls POST /api/internal/review-overdue/scan to get overdue
//      steps, then POST /api/internal/review-overdue/fire per step to
//      send the operator notification (warning at 24h hábiles,
// //      escalation to CEO at 48h hábiles).
//
// Each flow ends with:
//   * the per-kind `HTTP Request` node (scan + fire).
//   * a "Report Execution to Portal" `HTTP Request` node (KAIA-1073 +
//     KAIA-1080) POSTing to `/api/internal/n8n-execution` so the
//     operator flow-health dashboard's `lastN8nStatus` reflects the
//     wizard-lifecycle run too. Wired to the `main` (success) AND
//     `error` (failure) branches of every prior node — auto-detects
//     success/failure from the presence of `$json.error`.
//
// Output: 2 files in this folder, importable as-is via
//   n8n → Workflows → Import from File.
//
// Run:    npx tsx automations/wizard-lifecycle-triggers/build-flows.ts
// =============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type FlowKind = 'wizard-abandoned' | 'config-review-overdue';

interface FlowSpec {
  kind: FlowKind;
  filename: string;
  triggerDescription: string;
  cron: string;
  workflowLabel: string;
  milestoneHint: 'wizard_abandoned' | 'config_review_overdue' | 'null';
  routePath?: string; // URL path segment; defaults to kind
}

const FLOWS: FlowSpec[] = [
  {
    kind: 'wizard-abandoned',
    filename: 'wizard-abandoned.json',
    cron: '0 */6 * * *', // every 6h on the hour
    triggerDescription:
      'Every-6h schedule. Scans for clients in `configuring` whose latest `draft` write is > 48h old and who have not submitted since. Fires the Kira-voice recovery email and writes a `wizard_abandoned` ChatbotActivity row for the funnel view (KAIA-1170).',
    workflowLabel: 'Wizard Lifecycle — wizard_abandoned (KAIA-1172)',
    milestoneHint: 'wizard_abandoned',
  },
  {
    kind: 'config-review-overdue',
    filename: 'config-review-overdue.json',
    cron: '0 * * * *', // hourly on the hour
    triggerDescription:
      'Hourly schedule. Scans for ChatbotConfigStep rows in `submitted` (or `needs_revision` with a client response) older than 24h hábiles in the operator\'s timezone. Sends the operator notification; at >= 48h hábiles, escalates to the CEO via KAIRIKOS_CEO_EMAIL.',
    workflowLabel:
      'Wizard Lifecycle — config_review_overdue (KAIA-1172)',
    milestoneHint: 'config_review_overdue',
    routePath: 'review-overdue',
  },
];

function buildFlow(spec: FlowSpec): Record<string, unknown> {
  const idPrefix = `kairikos-${spec.kind.replace(/[^a-z0-9]/g, '-')}`;

  // Per-kind node definitions. The two flows share the same shell
  // shape (schedule → scan → if-loop → build → fire → log → report)
  // and only differ in the URL, the build-payload code, and the
  // workflow/milestone labels.
  const scanNode = {
    id: `${idPrefix}-scan`,
    name: `${spec.kind} — Scan`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [470, 300],
    parameters: {
      method: 'POST',
      url: `={{ $env.PORTAL_API_URL }}/api/internal/${spec.routePath ?? spec.kind}/scan`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          {
            name: 'X-Kairikos-Internal-Key',
            value: '={{ $env.PORTAL_API_KEY }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        spec.kind === 'config-review-overdue'
          ? `={{ JSON.stringify({ operatorTimezone: 'Europe/Madrid' }) }}`
          : `={{ JSON.stringify({}) }}`,
      options: {
        timeout: 15000,
        response: { response: { neverError: true } },
      },
    },
  };

  const splitNode = {
    id: `${idPrefix}-split-batches`,
    name: 'Split Into Batches',
    type: 'n8n-nodes-base.splitOut',
    typeVersion: 1,
    position: [690, 300],
    parameters: {
      fieldToSplitOut: 'candidates',
      options: {},
    },
  };

  const skipAlreadyFired = {
    id: `${idPrefix}-skip-already-fired`,
    name: 'If (skip alreadyFiredInWindow=true)',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.1,
    position: [910, 300],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'loose',
        },
        conditions: [
          {
            id: 'uuid-' + Math.random().toString(36).slice(2),
            name: 'alreadyFiredInWindow is true',
            operator: {
              type: 'boolean',
              operation: 'true',
            },
            value1: '={{ $json.alreadyFiredInWindow }}',
            value2: [true],
          },
        ],
        combinator: 'and',
      },
    },
  };

  const buildPayloadNode = {
    id: `${idPrefix}-build-payload`,
    name: 'Build Fire Payload',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1130, 300],
    parameters: {
      jsCode: buildFirePayloadCode(spec.kind),
    },
  };

  const fireNode = {
    id: `${idPrefix}-fire`,
    name: `POST /api/internal/${spec.kind}/fire`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1350, 300],
    parameters: {
      method: 'POST',
      url: `={{ $env.PORTAL_API_URL }}/api/internal/${spec.routePath ?? spec.kind}/fire`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          {
            name: 'X-Kairikos-Internal-Key',
            value: '={{ $env.PORTAL_API_KEY }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.payload) }}',
      options: {
        timeout: 15000,
        retry: { maxTries: 3, waitBetween: 5000 },
        response: { response: { neverError: true } },
      },
    },
  };

  const logNode = {
    id: `${idPrefix}-log`,
    name: 'Log Result',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1570, 300],
    parameters: {
      jsCode: [
        '// Surface the dedup / sent state in the workflow logs so the',
        '// operator can confirm via n8n that the alert reached the',
        '// portal. The portal persists the row regardless.',
        'const out = $input.first().json;',
        'const log = {',
        '  kind: "' + spec.kind + '",',
        '  ok: Boolean(out.ok),',
        '  deduped: Boolean(out.deduped),',
        '  resendMessageId: out.resendMessageId,',
        '  ceoCopied: out.ceoCopied,',
        '  sentAt: out.sentAt,',
        '};',
        'console.log(`[wizard-lifecycle] ' + spec.kind + ' ${JSON.stringify(log)}`);',
        'return [{ json: log }];',
      ].join('\n'),
    },
  };

  // KAIA-1073 execution capture — same shape as the AU-1 sibling
  // flows and the operator-notify flows. Reports to
  // /api/internal/n8n-execution on both success and error branches
  // of every prior node. The `workflow` literal is the per-flow
  // label, the `milestone` is the per-flow kind, and the
  // auto-detect of success/failure is from `$json.error`.
  const reportNode = {
    id: `${idPrefix}-report-execution`,
    name: 'Report Execution to Portal (KAIA-1073)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1790, 300],
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
      body: `={{ JSON.stringify((() => { const exec = $execution; const startedAt = exec && exec.startedAt ? new Date(exec.startedAt).toISOString() : new Date().toISOString(); const finishedAt = new Date().toISOString(); const errObj = $json && $json.error; const isFailure = Boolean(errObj); const upstream = $('Build Fire Payload').item && $('Build Fire Payload').item.json; const payload = (upstream && upstream.payload) || {}; const clientId = payload.clientId || null; const code = isFailure ? (errObj.name || (errObj.httpCode ? 'HTTP_' + errObj.httpCode : 'WORKFLOW_ERROR')) : 'OK'; const message = isFailure ? String(errObj.message || errObj.description || 'unknown n8n error').slice(0, 4000) : null; return { id: String(exec.id), clientId, clientName: null, workflow: ${JSON.stringify(spec.workflowLabel)}, milestone: ${spec.milestoneHint === 'null' ? 'null' : `'${spec.milestoneHint}'`}, status: isFailure ? 'failed' : 'success', startedAt, finishedAt, errorCode: isFailure ? String(code).slice(0, 100) : null, errorMessage: message }; })()) }}`,
      options: {
        timeout: 15000,
        retry: { maxTries: 3, waitBetween: 5000 },
        response: { response: { neverError: true } },
      },
    },
  };

  return {
    name: spec.workflowLabel,
    nodes: [
      {
        id: `${idPrefix}-trigger`,
        name: `${spec.kind} — Schedule`,
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1,
        position: [250, 300],
        parameters: {
          rule: {
            interval: [
              { field: 'cronExpression', expression: spec.cron },
            ],
          },
        },
      },
      scanNode,
      splitNode,
      skipAlreadyFired,
      buildPayloadNode,
      fireNode,
      logNode,
      reportNode,
    ],
    connections: {
      [`${idPrefix}-trigger`]: {
        main: [[{ node: `${idPrefix}-scan`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-scan`]: {
        main: [[{ node: `${idPrefix}-split-batches`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-split-batches`]: {
        main: [[{ node: `${idPrefix}-skip-already-fired`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-skip-already-fired`]: {
        main: [
          [],
          [{ node: `${idPrefix}-build-payload`, type: 'main', index: 0 }],
        ],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-build-payload`]: {
        main: [[{ node: `${idPrefix}-fire`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-fire`]: {
        main: [[{ node: `${idPrefix}-log`, type: 'main', index: 0 }]],
        error: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
      [`${idPrefix}-log`]: {
        main: [[{ node: `${idPrefix}-report-execution`, type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
    staticData: null,
    tags: [
      { name: 'kairikos' },
      { name: 'wizard-lifecycle' },
      { name: `kind:${spec.kind}` },
    ],
    active: false,
    pinData: {},
    versionId: '1.0.0',
    meta: {
      templateCredsSetupCompleted: false,
      executionCaptureIssue: 'KAIA-1073',
      linkedIssue: 'KAIA-1172',
    },
  };
}

// The "Build Fire Payload" code node. For each kind, it transforms
// the upstream scan response into the JSON the portal's `fire`
// endpoint expects.
//
// `wizard-abandoned` payload:
//   { clientId, lastDraftAt, lastStepKey, hoursSinceLastDraft }
//
// `config-review-overdue` payload:
//   { stepId, clientId, stepKey, stepVersion, status,
//     severity, businessHoursElapsed, operatorTimezone }
function buildFirePayloadCode(kind: FlowKind): string {
  if (kind === 'wizard-abandoned') {
    return [
      '// Wizard-abandoned fire payload builder.',
      '// Input: one scan-candidate item (already split out of the',
      '// scan response and pre-filtered for alreadyFiredInWindow).',
      '// Output: the body shape the /api/internal/wizard-abandoned/fire',
      '// route expects. The route is the only writer — it does the',
      '// dedup on @@unique([clientId, milestone=\'wizard_abandoned\'])',
      '// and the Resend send.',
      'const input = $input.first().json;',
      'return [{',
      '  json: {',
      '    payload: {',
      '      clientId: input.clientId,',
      '      lastDraftAt: input.lastDraftAt,',
      '      lastStepKey: input.lastStepKey,',
      '      hoursSinceLastDraft: Math.max(0, Math.round(Number(input.hoursSinceLastDraft) || 0)),',
      '    },',
      '  },',
      '}];',
    ].join('\n');
  }
  return [
    '// config-review-overdue fire payload builder.',
    '// Input: one scan-candidate item (one row of submitted/needs_revision',
    '// with client response whose businessHoursElapsed has crossed 24h).',
    '// Output: the body shape /api/internal/review-overdue/fire expects.',
    '// The route dispatches the kind based on `severity` and is the only',
    '// writer of OperatorNotification rows.',
    'const input = $input.first().json;',
    'return [{',
    '  json: {',
    '    payload: {',
    '      stepId: input.stepId,',
    '      clientId: input.clientId,',
    '      stepKey: input.stepKey,',
    '      stepVersion: input.stepVersion,',
    '      status: input.status,',
    '      severity: input.severity,',
    '      businessHoursElapsed: Number(input.businessHoursElapsed) || 0,',
    '      operatorTimezone: input.operatorTimezone || \'Europe/Madrid\',',
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

    // Also emit a `.api.json` next to each file with the fields the
    // n8n REST API v1 create endpoint accepts. The UI `Import from
    // File` accepts the full shape; the API rejects `tags`, `active`,
    // `versionId`, `meta`, `pinData` on create. The stripped shape
    // is what `npx tsx scripts/import-to-n8n.ts` POSTs.
    const apiFlow = stripForApiCreate(flow);
    const apiOut = resolve(__dirname, spec.filename.replace(/\.json$/, '.api.json'));
    writeFileSync(apiOut, JSON.stringify(apiFlow, null, 2));
    console.log(`[build-flows] wrote ${apiOut.split('/').pop()} (API-create shape)`);
  }
  console.log('[build-flows] OK — 2 wizard-lifecycle flows generated (+ .api.json siblings)');
}

// Strip the fields the n8n REST API v1 create endpoint rejects:
//   - `tags`     (read-only on create — set via update / n8n UI)
//   - `active`   (read-only on create — set via /activate endpoint)
//   - `versionId` (server-assigned UUID; sending a literal fails 400)
//   - `meta`     (accepted on update, rejected on create)
//   - `pinData`  (accepted on update, rejected on create)
function stripForApiCreate(flow) {
  const { name, nodes, connections, settings, staticData } = flow;
  return { name, nodes, connections, settings, staticData };
}

main();
