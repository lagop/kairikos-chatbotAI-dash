import 'server-only';
import { prisma } from './prisma';
import { resolveOperatorRecipients, resolveCeoRecipient, type OperatorRecipient } from './operator-notify';

// =============================================================================
// 2026-09-15 — a quién le llegan las alertas de operador, configurable desde
// /admin/portal/settings/alerts.
//
// Hasta hoy solo existía KAIRIKOS_OPERATOR_EMAILS / KAIRIKOS_CEO_EMAIL, y en
// producción esas variables nunca llegaron al contenedor (no estaban en
// deploy.yml). resolveOperatorRecipients devolvía [] y cada alerta —altas
// atascadas, tokens a punto de caducar, WhatsApp de un negocio caído— se
// saltaba sin error. Se descubrió porque un negocio llevaba un día entero
// sin WhatsApp y nadie se había enterado.
//
// Mismo molde que seo-settings.ts: fila singleton en Postgres que manda en
// cuanto existe, variable de entorno como respaldo mientras no. Así un
// cambio de destinatario no exige redesplegar — que es justo el paso que
// falló.
//
// NUNCA LANZA al leer. Una base de datos caída no puede además dejar sin
// alertas: se cae a la variable. Por eso también se puede llamar desde
// cualquier barrido sin envolverlo en try.
// =============================================================================

export const OPERATOR_ALERT_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000002';

/** Un tope razonable: esto es una lista de personas del equipo, no una
 *  lista de distribución. */
export const MAX_OPERATOR_EMAILS = 10;

// Deliberadamente simple: lo que se quiere cazar es una errata al teclear
// ("kairikos.devs@gmail", un espacio de más), no validar el RFC 5322.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export type AlertRecipientSource = 'portal' | 'env' | 'none';

export interface OperatorAlertSettingsView {
  operatorEmails: string[];
  operatorSource: AlertRecipientSource;
  ceoEmail: string | null;
  ceoSource: AlertRecipientSource;
  updatedAt: Date | null;
  updatedBy: string | null;
}

async function readRow() {
  try {
    return await prisma.operatorAlertSettings.findUnique({ where: { id: OPERATOR_ALERT_SETTINGS_SINGLETON_ID } });
  } catch {
    return null;
  }
}

/** Lo que usan todos los que envían una alerta. */
export async function getOperatorAlertRecipients(): Promise<OperatorRecipient[]> {
  const row = await readRow();
  if (row && row.operatorEmails.length > 0) return row.operatorEmails.map((email) => ({ email }));
  return resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);
}

/** Solo la escalada review-overdue. */
export async function getCeoAlertEmail(): Promise<string | null> {
  const row = await readRow();
  if (row?.ceoEmail) return row.ceoEmail;
  return resolveCeoRecipient(process.env.KAIRIKOS_CEO_EMAIL);
}

/** Lo que muestra la pantalla: el valor efectivo y de dónde sale. */
export async function getOperatorAlertSettingsView(): Promise<OperatorAlertSettingsView> {
  const row = await readRow();
  const envOperators = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS).map((r) => r.email);
  const envCeo = resolveCeoRecipient(process.env.KAIRIKOS_CEO_EMAIL);

  const fromPortal = row !== null && row.operatorEmails.length > 0;
  const operatorEmails = fromPortal ? row.operatorEmails : envOperators;
  const ceoEmail = row?.ceoEmail ?? envCeo;

  return {
    operatorEmails,
    operatorSource: fromPortal ? 'portal' : envOperators.length > 0 ? 'env' : 'none',
    ceoEmail,
    ceoSource: row?.ceoEmail ? 'portal' : envCeo ? 'env' : 'none',
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export type NormalisedAlertSettings =
  | { ok: true; operatorEmails: string[]; ceoEmail: string | null }
  | { ok: false; error: 'invalid_email'; invalid: string[] }
  | { ok: false; error: 'no_operator_emails' }
  | { ok: false; error: 'too_many_emails' };

/**
 * Valida y limpia lo que manda la pantalla. Pura, para probarla sin base.
 *
 * Exige al menos un destinatario de alertas: guardar la lista vacía dejaría
 * que la variable de entorno volviera a mandar sin que el operador lo
 * viera, y "no alertar a nadie" no es una configuración que se quiera
 * poder elegir por error.
 */
export function normaliseAlertSettings(input: { operatorEmails: string; ceoEmail: string }): NormalisedAlertSettings {
  const operatorEmails = [
    ...new Set(
      input.operatorEmails
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  ];
  const ceo = input.ceoEmail.trim().toLowerCase();

  const invalid = [...operatorEmails, ...(ceo ? [ceo] : [])].filter((e) => !EMAIL_RE.test(e));
  if (invalid.length > 0) return { ok: false, error: 'invalid_email', invalid };
  if (operatorEmails.length === 0) return { ok: false, error: 'no_operator_emails' };
  if (operatorEmails.length > MAX_OPERATOR_EMAILS) return { ok: false, error: 'too_many_emails' };

  return { ok: true, operatorEmails, ceoEmail: ceo || null };
}

export async function updateOperatorAlertSettings(
  input: { operatorEmails: string[]; ceoEmail: string | null },
  actorEmail: string | null,
): Promise<void> {
  await prisma.operatorAlertSettings.upsert({
    where: { id: OPERATOR_ALERT_SETTINGS_SINGLETON_ID },
    create: { id: OPERATOR_ALERT_SETTINGS_SINGLETON_ID, ...input, updatedBy: actorEmail },
    update: { ...input, updatedBy: actorEmail },
  });
}
