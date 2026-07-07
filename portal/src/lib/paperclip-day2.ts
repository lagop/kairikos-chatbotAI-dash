import 'server-only';

// =============================================================================
// KAIA-2913 — Paperclip issue creation for the onboarding Day-2 task.
//
// When the in-house intake endpoint accepts a submission it creates a
// Paperclip execution issue assigned to the Automation Engineer so the
// Day-2 onboarding workflow (T+0 in n8n) starts automatically without
// manual ticket triage.
//
// Configuration (env vars; server-side only):
//   PAPERCLIP_API_URL   — control plane base URL (REQUIRED). Same value the
//                         other internal flows use.
//   PAPERCLIP_API_KEY   — long-lived JWT for the Automation Engineer agent
//                         (REQUIRED). Lives in Secret Manager.
//   PAPERCLIP_COMPANY_ID — Kairikos company id (REQUIRED).
//   PAPERCLIP_DAY2_AGENT_ID — agent id of the Automation Engineer
//                              (REQUIRED for assignment). Falls back to
//                              unassigned when unset.
//
// Failure mode: the route handler logs + tolerates a non-2xx response. The
// operator can always re-trigger Day-2 from the admin panel.
// =============================================================================

export interface Day2IssueInput {
  clientName: string;
  vertical: string;
  clientId: string;
  humanHandoffEmail: string;
  intakeSubmissionId: string;
}

export interface Day2IssueResult {
  ok: boolean;
  issueId?: string;
  issueIdentifier?: string;
  skipped?: 'not_configured' | 'api_error';
  error?: string;
}

interface PaperclipEnvSnapshot {
  apiUrl: string | undefined;
  apiKey: string | undefined;
  companyId: string | undefined;
  agentId: string | undefined;
}

function readEnv(): PaperclipEnvSnapshot {
  return {
    apiUrl: process.env.PAPERCLIP_API_URL,
    apiKey: process.env.PAPERCLIP_API_KEY,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    agentId: process.env.PAPERCLIP_DAY2_AGENT_ID,
  };
}

export async function createDay2OnboardingIssue(
  input: Day2IssueInput,
): Promise<Day2IssueResult> {
  const env = readEnv();
  if (!env.apiUrl || !env.apiKey || !env.companyId) {
    return {
      ok: false,
      skipped: 'not_configured',
      error:
        'PAPERCLIP_API_URL/KEY/COMPANY_ID not set; skipping Day-2 issue creation',
    };
  }

  const title = `Onboarding ${input.clientName} · Día 2`;
  const description = [
    `## Origen`,
    ``,
    `Issue Paperclip abierto automáticamente por la ingesta in-house del portal (KAIA-2913).`,
    ``,
    `- Cliente: ${input.clientName}`,
    `- Vertical: ${input.vertical}`,
    `- ChatbotClient.id: \`${input.clientId}\``,
    `- IntakeSubmission.id: \`${input.intakeSubmissionId}\``,
    `- Email handoff humano: ${input.humanHandoffEmail}`,
    ``,
    `## Tareas Día 2`,
    ``,
    `1. Confirmar carpeta Drive creada (operador verifica la URL en la notificación inicial).`,
    `2. Arrancar el workflow T+0 de onboarding (envío del kit + creación del bot placeholder).`,
    `3. Revisar el payload \`00_Intake.json\` y validar FAQs, canales y horarios.`,
    `4. Marcar el cliente como \`go-live-pending\` cuando el bot placeholder esté listo.`,
    ``,
    `## Notas`,
    ``,
    `El endpoint público ya validó Zod, persistió la submission y notificó al CEO. Esta issue es la pista operativa para el Día 2.`,
  ].join('\n');

  const url = `${env.apiUrl.replace(/\/$/, '')}/api/companies/${env.companyId}/issues`;
  const body: Record<string, unknown> = {
    title,
    description,
    priority: 'high',
    status: 'todo',
    kind: 'intake_day2',
  };
  // Defensive: Paperclip rejects 400 "Invalid uuid" if assigneeAgentId is malformed
  // (e.g. an old Paperclip user-id like "AXvGsJxnGWhZgJfsBE0nwMQkW6JMTcJA" rather
  // than a UUID). A modern agent-id is a 36-char [0-9a-f-]+ UUID. Drop silently
  // if it doesn't look like one — the issue still lands, just unassigned.
  if (env.agentId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.agentId)) {
    body.assigneeAgentId = env.agentId;
  } else if (env.agentId) {
    // eslint-disable-next-line no-console
    console.warn(`[paperclip-day2] PAPERCLIP_DAY2_AGENT_ID is set but not a UUID; skipping assignment. Got length=${env.agentId.length}`);
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return {
        ok: false,
        skipped: 'api_error',
        error: `Paperclip issue create failed: ${res.status} ${await safeText(res)}`,
      };
    }

    const json = (await res.json()) as {
      id?: string;
      identifier?: string;
    };
    return {
      ok: true,
      issueId: json.id,
      issueIdentifier: json.identifier,
    };
  } catch (err) {
    return {
      ok: false,
      skipped: 'api_error',
      error: `Paperclip issue create threw: ${(err as Error).message}`,
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}