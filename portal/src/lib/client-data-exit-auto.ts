import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  EXIT_CONTRACT_CODES,
  EXIT_PRODUCTS,
  loadExit,
  notifyExit,
  purgeExit,
  type ExitCounts,
  type ExitProduct,
} from './client-data-exit';
import type { SendResult } from './cartera/emails';
import { resolveActiveTwilioCredentials } from './twilio-credentials';
import { getOperatorAlertRecipients } from './operator-alert-settings';
import { sendOperatorNotification, type SendOperatorNotificationInput, type SendOperatorNotificationResult } from './operator-notify';
import { logError } from './observability';

// =============================================================================
// RGPD, encargo del tratamiento — PR 5b del plan (26/11/2026): la baja de los
// datos del chat, las llamadas y las solicitudes, sola, como villas y cartera.
// Las reglas y los borrados son los del PR 5a (lib/client-data-exit.ts); aquí
// solo se decide cuándo toca cada paso. Lo llama el cron retention-purge.
//
// En cada pasada, para cada cliente con alguna contratación dada de baja y
// para cada producto (chatbot, recall, leads):
//   - Si todas las contrataciones que deciden están dadas de baja, hay datos y
//     aún no se avisó de esta baja: el aviso al cliente (correo con el plazo y
//     dónde descargar). Sin datos no se avisa: no hay nada que devolver.
//   - Si ya se avisó y pasó el plazo (30 días desde la baja, nunca menos de 7
//     desde el aviso): el borrado.
//   - Si ya se borró lo de esta baja, nada.
// Lo que el cron no puede resolver solo —el correo al cliente no sale, el
// número de llamadas sigue asignado, Twilio falla— se le dice al operador con
// un correo por cliente y día (OperatorNotification, kind 'client-data-exit').
// Ese mismo registro hace de freno: ese cliente no se reintenta hasta el día
// siguiente, así que un correo que falla no se intenta cada cinco minutos.
//
// El operador puede adelantarse con scripts/baja-datos-cliente.sh: el cron ve
// el aviso o el borrado que hizo y sigue desde ahí.
// =============================================================================

export const CLIENT_DATA_EXIT_ACTOR = 'system:client-data-exit' as const;
export const CLIENT_DATA_EXIT_ALERT_KIND = 'client-data-exit' as const;
/** Avisos y borrados por pasada: el resto queda para la siguiente, 5 minutos después. */
export const MAX_EXIT_ACTIONS_PER_TICK = 10;

export interface ClientDataExitProblem {
  product: ExitProduct;
  error: string;
  detail?: string;
}

export interface ClientDataExitRunResult {
  /** Clientes con alguna contratación de estos productos dada de baja. */
  clients: number;
  notified: number;
  purged: number;
  problems: number;
  operatorAlerts: number;
  /** Se paró en MAX_EXIT_ACTIONS_PER_TICK. */
  truncated: boolean;
}

export interface ClientDataExitOptions {
  send?: (to: string, email: { subject: string; text: string; html: string }) => Promise<SendResult>;
  twilioAuth?: () => Promise<{ accountSid: string; authToken: string } | null>;
  /** El correo al operador. Por defecto, Resend a los destinatarios de alertas del portal. */
  alert?: (msg: Pick<SendOperatorNotificationInput, 'subject' | 'text' | 'html'>) => Promise<SendOperatorNotificationResult>;
}

const alertOperators: NonNullable<ClientDataExitOptions['alert']> = async (msg) =>
  sendOperatorNotification({ ...msg, kind: CLIENT_DATA_EXIT_ALERT_KIND, to: await getOperatorAlertRecipients() });

function hasData(c: ExitCounts): boolean {
  return (c.conversations ?? 0) + (c.digests ?? 0) + (c.calls ?? 0) + (c.leads ?? 0) + c.outboundMessages > 0;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const PRODUCT_NAME: Record<ExitProduct, string> = { chatbot: 'chat', recall: 'llamadas', leads: 'solicitudes' };

function explain(p: ClientDataExitProblem, clientId: string): string {
  const name = PRODUCT_NAME[p.product];
  const detail = p.detail ? ` (${p.detail})` : '';
  switch (p.error) {
    case 'email_failed':
      return `${name}: no salió el correo de aviso al cliente${detail}. El plazo no empieza a contar hasta que salga: revisa su email en el admin.`;
    case 'number_still_assigned':
      return `${name}: pasó el plazo, pero el número sigue asignado. Libéralo en el admin, /admin/portal/recall, sección «Números de clientes dados de baja»; hasta entonces no se borra nada.`;
    case 'twilio_not_configured':
      return `${name}: quedan grabaciones en Twilio y el portal no tiene credenciales de Twilio. No se ha borrado nada.`;
    case 'twilio_failed':
      return `${name}: Twilio falló al borrar una grabación${detail}. No se ha borrado nada en la base de datos.`;
    default:
      return `${name}: ${p.error}${detail}. Míralo con scripts/baja-datos-cliente.sh estado --cliente ${clientId} --producto ${p.product}.`;
  }
}

/** Un correo por cliente y día. false si ya se mandó hoy (o lo reclamó otra pasada). */
async function alertOperator(
  db: PrismaClient,
  client: { id: string; name: string; tenantId: string | null },
  problems: ClientDataExitProblem[],
  now: Date,
  alert: NonNullable<ClientDataExitOptions['alert']>,
): Promise<boolean> {
  const subject = `Baja de datos de ${client.name}: hace falta que mires algo`;
  try {
    await db.operatorNotification.create({
      data: { clientId: client.id, tenantId: client.tenantId, kind: CLIENT_DATA_EXIT_ALERT_KIND, day: utcDay(now), subject },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
  const lineas = [
    `La baja automática de los datos de ${client.name} (${client.id}) se ha parado en:`,
    '',
    ...problems.map((p) => `- ${explain(p, client.id)}`),
    '',
    'Se vuelve a intentar mañana. Procedimiento: portal/docs/runbooks/baja-datos-cliente.md.',
  ];
  const sent = await alert({
    subject,
    text: lineas.join('\n'),
    html: `<pre style="font-family:system-ui,sans-serif">${lineas.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n')}</pre>`,
  });
  // La fila se queda aunque el correo falle: es también el freno de los
  // reintentos. El fallo queda en el log de errores.
  if (!sent.ok) logError('client_data_exit.alert_failed', new Error(sent.error), { clientId: client.id }, 'error');
  return sent.ok;
}

export async function runClientDataExits(
  db: PrismaClient,
  now: Date = new Date(),
  opts: ClientDataExitOptions = {},
): Promise<ClientDataExitRunResult> {
  const result: ClientDataExitRunResult = { clients: 0, notified: 0, purged: 0, problems: 0, operatorAlerts: 0, truncated: false };
  const codes = [...new Set(EXIT_PRODUCTS.flatMap((p) => EXIT_CONTRACT_CODES[p]))];
  const [rows, alertedToday] = await Promise.all([
    db.clientProduct.findMany({
      where: { status: 'cancelled', product: { code: { in: codes } } },
      select: { clientId: true },
      distinct: ['clientId'],
      orderBy: { clientId: 'asc' },
    }),
    db.operatorNotification.findMany({
      where: { kind: CLIENT_DATA_EXIT_ALERT_KIND, day: utcDay(now), clientId: { not: null } },
      select: { clientId: true },
    }),
  ]);
  result.clients = rows.length;
  const skip = new Set(alertedToday.map((r) => r.clientId));
  const alert = opts.alert ?? alertOperators;
  let actions = 0;

  for (const { clientId } of rows) {
    if (skip.has(clientId)) continue;
    if (actions >= MAX_EXIT_ACTIONS_PER_TICK) {
      result.truncated = true;
      break;
    }
    const problems: ClientDataExitProblem[] = [];
    let client: { id: string; name: string; tenantId: string | null } | null = null;
    let current: ExitProduct = EXIT_PRODUCTS[0];
    try {
      for (const product of EXIT_PRODUCTS) {
        current = product;
        const loaded = await loadExit(db, clientId, product, now);
        const { status } = loaded;
        if (loaded.client) client = { id: loaded.client.id, name: loaded.client.companyName?.trim() || loaded.client.name, tenantId: loaded.client.tenantId };
        if (status.purgedAt) continue;
        if (status.blockers.some((b) => b === 'client_not_found' || b === 'no_contract' || b === 'contract_not_cancelled')) continue;

        if (!status.notifiedAt) {
          if (!hasData(status.counts)) continue;
          actions++;
          const r = await notifyExit(db, clientId, product, CLIENT_DATA_EXIT_ACTOR, now, opts.send ? { send: opts.send } : {});
          if (r.ok) result.notified++;
          else problems.push({ product, error: r.error, detail: r.detail });
          continue;
        }
        if (status.state !== 'closed') continue;

        actions++;
        const r = await purgeExit(db, clientId, product, CLIENT_DATA_EXIT_ACTOR, true, now, {
          twilioAuth: opts.twilioAuth ?? resolveActiveTwilioCredentials,
        });
        if (r.ok) result.purged++;
        else problems.push({ product, error: r.error, detail: r.detail });
      }
    } catch (err) {
      logError('client_data_exit.auto_failed', err, { clientId }, 'error');
      problems.push({ product: current, error: 'exception', detail: err instanceof Error ? err.message : String(err) });
    }

    if (problems.length > 0 && client) {
      result.problems += problems.length;
      try {
        if (await alertOperator(db, client, problems, now, alert)) result.operatorAlerts++;
      } catch (err) {
        logError('client_data_exit.alert_failed', err, { clientId }, 'error');
      }
    }
  }
  return result;
}
