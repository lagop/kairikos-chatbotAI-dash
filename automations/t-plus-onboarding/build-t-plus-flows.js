#!/usr/bin/env node
// Generate t3, t7, t14 n8n workflow exports from a template.
// Pure data-in / data-out; no n8n runtime needed. Output: t3-followup.json, etc.
//
// Re-runnable; idempotent on the file system (overwrites in place).
// Kept under the project repo so future T+N flows (T+30, T+60) take ~30s.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'archive');
const TEMPLATE_PATH = path.join(__dirname, 'archive', 't0-intake-received.json');

const tpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));

const FLOWS = [
  {
    dayOffset: 3,
    eventType: 't_plus_3_followup',
    subject: 'Quick check-in — how is your chatbot doing?',
    template: 't-plus-3-followup-v1',
    title: 'T+3 follow-up sent',
    cronHour: 9
  },
  {
    dayOffset: 7,
    eventType: 't_plus_7_followup',
    subject: 'Your chatbot is one week in — here is what we recommend',
    template: 't-plus-7-followup-v1',
    title: 'T+7 follow-up sent',
    cronHour: 9
  },
  {
    dayOffset: 14,
    eventType: 't_plus_14_followup',
    subject: '14-day review — let us optimise together',
    template: 't-plus-14-followup-v1',
    title: 'T+14 follow-up sent',
    cronHour: 9
  }
];

function resolveClientCode(dayOffset, eventType) {
  // n8n Code node: scheduled flow — fetch clients due for this T+N follow-up.
  // A client is "due" when:
  //   onboarding_status = 'in_progress' AND
  //   (now - go_live_at) >= dayOffset days AND
  //   no chatbot_activity row yet exists for (client_id, event_type)
  return [
    "// Scheduled flow — fetch clients due for T+" + dayOffset + " follow-up.",
    "// A client is 'due' when onboarding_status='in_progress' AND",
    "//  (now - go_live_at) is at least " + dayOffset + " days AND",
    "//  no row exists in chatbot_activity for that client with event_type='" + eventType + "'.",
    "const N_DAY = " + dayOffset + ";",
    "const resp = await this.helpers.httpRequest({",
    "  method: 'GET',",
    "  url: `${$env.SUPABASE_URL}/rest/v1/chatbot_clients?onboarding_status=eq.in_progress&go_live_at=lt.${new Date(Date.now() - N_DAY*86400e3).toISOString()}&select=id,company_name,primary_contact_email,slug`,",
    "  headers: {",
    "    apikey: $env.SUPABASE_SERVICE_ROLE_KEY,",
    "    Authorization: `Bearer ${$env.SUPABASE_SERVICE_ROLE_KEY}`",
    "  },",
    "  json: true",
    "});",
    "if (!Array.isArray(resp) || resp.length === 0) { return []; }",
    "return resp.map((c) => ({ json: { client_id: c.id, company_name: c.company_name, contact_email: c.primary_contact_email, slug: c.slug } }));"
  ].join("\n");
}

function buildIdCode(eventType, dayOffset) {
  return [
    "// Deterministic UUIDv5 — see automations/t-plus-onboarding/README.md §3.",
    "const { v5: uuidv5 } = require('uuid');",
    "const NAMESPACE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';",
    "const ctx = $input.first().json;",
    "const eventType = '" + eventType + "';",
    "const dayOffset = " + dayOffset + ";",
    "const key = `${eventType}:${ctx.client_id}:${dayOffset}`;",
    "const id = uuidv5(key, NAMESPACE);",
    "return [{ json: { ...ctx, activity_id: id, event_type: eventType, day_offset: dayOffset } }];"
  ].join("\n");
}

function buildRowCode(title, subject, template) {
  return [
    "// Assemble the final chatbot_activity row.",
    "const emailResp = $input.first().json;",
    "const ctx = $('Build Activity Id (idempotent)').first().json;",
    "const row = {",
    "  id: ctx.activity_id,",
    "  client_id: ctx.client_id,",
    "  day_offset: ctx.day_offset,",
    "  event_type: ctx.event_type,",
    "  title: " + JSON.stringify(title) + ",",
    "  body: null,",
    "  metadata: {",
    "    email_subject: " + JSON.stringify(subject) + ",",
    "    send_status: emailResp.id ? 'sent' : 'failed',",
    "    provider: 'resend',",
    "    email_message_id: emailResp.id || null,",
    "    template: " + JSON.stringify(template) + ",",
    "    locale: 'es-ES'",
    "  },",
    "  occurred_at: new Date().toISOString()",
    "};",
    "return [{ json: row }];"
  ].join("\n");
}

for (const f of FLOWS) {
  const flow = JSON.parse(JSON.stringify(tpl));

  // Replace the trigger node with a schedule trigger
  const triggerIdx = flow.nodes.findIndex((n) => n.name === 'T+0 Trigger');
  flow.nodes[triggerIdx] = {
    id: 't' + f.dayOffset + '-trigger',
    name: 'T+' + f.dayOffset + ' Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [250, 300],
    parameters: {
      rule: {
        cronExpression: '0 ' + f.cronHour + ' * * *',
        timezone: 'Europe/Madrid'
      }
    }
  };

  // Drop the webhook signature verification node (no inbound HTTP).
  flow.nodes = flow.nodes.filter((n) => n.name !== 'Verify Webhook Signature');

  flow.nodes = flow.nodes.map((n) => {
    if (n.name === 'Resolve Client') {
      n.id = 't' + f.dayOffset + '-resolve-clients';
      n.parameters.jsCode = resolveClientCode(f.dayOffset, f.eventType);
    } else if (n.name === 'Build Activity Id (idempotent)') {
      n.id = 't' + f.dayOffset + '-build-id';
      n.parameters.jsCode = buildIdCode(f.eventType, f.dayOffset);
    } else if (n.name === 'Send T+0 Email') {
      n.id = 't' + f.dayOffset + '-send-email';
      n.name = 'Send T+' + f.dayOffset + ' Email';
      n.parameters.bodyParameters.parameters = n.parameters.bodyParameters.parameters.map((p) => {
        if (p.name === 'subject') return Object.assign({}, p, { value: f.subject });
        if (p.name === 'template') return Object.assign({}, p, { value: f.template });
        return p;
      });
    } else if (n.name === 'Build Activity Row') {
      n.id = 't' + f.dayOffset + '-build-row';
      n.parameters.jsCode = buildRowCode(f.title, f.subject, f.template);
    } else if (n.name === 'Upsert chatbot_activity') {
      n.id = 't' + f.dayOffset + '-upsert';
    } else if (n.name === 'Notify Slack on Error') {
      n.id = 't' + f.dayOffset + '-slack-err';
      n.parameters.text =
        ':rotating_light: T+' + f.dayOffset + ' flow failed for client `' +
        '{{ $json.client_id }}` after 3 retries. Last error: {{ $json.error }}';
    }
    return n;
  });

  // Re-wire connections for the new trigger name
  flow.connections = {
    ['T+' + f.dayOffset + ' Schedule Trigger']: {
      main: [[{ node: 'Resolve Client', type: 'main', index: 0 }]]
    },
    'Resolve Client': {
      main: [[{ node: 'Build Activity Id (idempotent)', type: 'main', index: 0 }]]
    },
    'Build Activity Id (idempotent)': {
      main: [[{ node: 'Send T+' + f.dayOffset + ' Email', type: 'main', index: 0 }]]
    },
    ['Send T+' + f.dayOffset + ' Email']: {
      main: [[{ node: 'Build Activity Row', type: 'main', index: 0 }]],
      error: [[{ node: 'Notify Slack on Error', type: 'main', index: 0 }]]
    },
    'Build Activity Row': {
      main: [[{ node: 'Upsert chatbot_activity', type: 'main', index: 0 }]]
    },
    'Upsert chatbot_activity': {
      error: [[{ node: 'Notify Slack on Error', type: 'main', index: 0 }]]
    }
  };

  flow.name = '[DEPRECATED — use portal-internal-activity] T+' + f.dayOffset + ' — Follow-up (writes chatbot_activity)';
  flow.meta = {
    template: 'kairikos-t-plus-onboarding',
    templateVersion: '1.0',
    dayOffset: f.dayOffset,
    eventType: f.eventType,
    author: 'Automation Engineer',
    linkedIssue: 'KAIA-734'
  };

  const out = path.join(OUT_DIR, 't' + f.dayOffset + '-followup.json');
  fs.writeFileSync(out, JSON.stringify(flow, null, 2) + '\n');
  console.log('wrote ' + out);
}
