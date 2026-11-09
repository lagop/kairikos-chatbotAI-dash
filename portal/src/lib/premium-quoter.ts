import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import defaultData from './premium-quoter-default.json';
import {
  checkAnswers,
  compute,
  fmt,
  QUOTER_CALL_SLOTS,
  QUOTER_CONSENT,
  resolveQuoter,
  type QuoterData,
  type QuoterEstimate,
} from './premium-quoter-engine';
import { validateQuoterData } from './premium-quoter-schema';
import { loadPublicCatalog } from './public-catalog';
import { hashIp } from './public-draft-request';
import { getOperatorAlertRecipients } from './operator-alert-settings';
import { sendOperatorNotification } from './operator-notify';
import { logError } from './observability';

// =============================================================================
// Presupuestador de Kairikos Web Premium — el servidor (09/11/2026).
//
// Tres decisiones que no se ven en el código:
//
// - Los precios de los servicios de Kairikos salen de loadPublicCatalog, la
//   misma lectura que alimenta /planes/. Aquí se lee en vivo y no se commitea
//   una copia como hace kairikos.com, porque esta página la sirve el portal.
//
// - El navegador manda su `estimacion`, pero no se usa. El importe que llega a
//   la bandeja lo calcula este servidor con las respuestas: si no, cualquiera
//   podría dejar en la cola un presupuesto con el precio que quisiera.
//
// - Esto NO crea un Lead. Lead es el CRM de CADA cliente y exige un clientId;
//   quien pide aquí un presupuesto todavía no es cliente de nadie. Los contactos
//   comerciales de kairikos.com viven en su propia tabla y su propia bandeja,
//   igual que PublicDraftRequest. Los frenos también son los suyos, sin el
//   global de gasto (aquí no se llama a ninguna IA): tope por IP y día, un tope
//   diario contra el spam, y el campo trampa.
// =============================================================================

export const MAX_REQUESTS_PER_IP_PER_DAY = 5;
export const MAX_REQUESTS_PER_DAY_GLOBAL = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActiveQuoterData {
  /** 0 = todavía nadie ha guardado nada: son los datos de fábrica. */
  version: number;
  data: QuoterData;
}

/** La versión vigente. Null si la guardada ya no valida (ver el comentario). */
export async function loadActiveQuoterData(prisma: Pick<PrismaClient, 'premiumQuoterVersion'>): Promise<ActiveQuoterData | null> {
  const row = await prisma.premiumQuoterVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true, data: true } });
  const raw: unknown = row ? row.data : defaultData;
  const checked = validateQuoterData(raw);
  if (!checked.ok) {
    // Solo pasa si un despliegue cambia el esquema sin migrar los datos: lo
    // guardado pasó la validación de su momento. Se apaga la página, no se
    // improvisa con los datos de fábrica, que podrían ser muy distintos.
    logError('premium_quoter.invalid_stored_data', new Error(checked.problems.join(' | ')), { version: row?.version ?? 0 });
    return null;
  }
  return { version: row?.version ?? 0, data: checked.data };
}

export type LoadQuoterResult =
  | { ok: true; version: number; quoter: QuoterData }
  | { ok: false; reason: 'invalid_data' | 'missing_prices'; missing?: string[] };

/** Los datos vigentes con los importes del catálogo ya puestos. */
export async function loadResolvedQuoter(prisma: Pick<PrismaClient, 'premiumQuoterVersion' | 'product'>): Promise<LoadQuoterResult> {
  const active = await loadActiveQuoterData(prisma);
  if (!active) return { ok: false, reason: 'invalid_data' };
  const resolved = resolveQuoter(active.data, await loadPublicCatalog(prisma));
  if (!resolved.ok) {
    logError('premium_quoter.missing_catalog_prices', new Error(resolved.missing.join(', ')), { version: active.version });
    return { ok: false, reason: 'missing_prices', missing: resolved.missing };
  }
  return { ok: true, version: active.version, quoter: resolved.quoter };
}

export type SaveQuoterResult =
  | { ok: true; version: number }
  | { ok: false; error: 'invalid'; problems: string[] }
  | { ok: false; error: 'conflict'; currentVersion: number };

/**
 * Guarda una versión nueva. `basedOn` es la que tenía delante el operador: si
 * otro ha guardado mientras tanto se rechaza, para no pisar su cambio.
 */
export async function saveQuoterVersion(
  prisma: Pick<PrismaClient, 'premiumQuoterVersion' | 'product'>,
  input: { data: unknown; basedOn: number; operatorEmail: string | null; note?: string | null },
): Promise<SaveQuoterResult> {
  const checked = validateQuoterData(input.data);
  if (!checked.ok) return { ok: false, error: 'invalid', problems: checked.problems };

  // Un catálogo al que le falte una referencia apagaría la página publicada.
  const resolved = resolveQuoter(checked.data, await loadPublicCatalog(prisma));
  if (!resolved.ok) {
    return { ok: false, error: 'invalid', problems: resolved.missing.map((m) => `El catálogo no tiene «${m}».`) };
  }

  const latest = await prisma.premiumQuoterVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
  const current = latest?.version ?? 0;
  if (current !== input.basedOn) return { ok: false, error: 'conflict', currentVersion: current };

  try {
    await prisma.premiumQuoterVersion.create({
      data: {
        version: current + 1,
        data: checked.data as unknown as Prisma.InputJsonValue,
        operatorEmail: input.operatorEmail,
        note: input.note?.trim() || null,
      },
    });
  } catch (err) {
    // Dos guardados a la vez: el índice único deja pasar a uno solo.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, error: 'conflict', currentVersion: current + 1 };
    }
    throw err;
  }
  return { ok: true, version: current + 1 };
}

export interface PremiumQuoteInput {
  nombre: string;
  empresa: string;
  email: string;
  tel?: string;
  web?: string;
  franja: string;
  sector: string;
  respuestas: Record<string, unknown>;
  /** El campo trampa: una persona no lo ve. */
  trap?: string;
  ip: string;
}

export type CreateQuoteResult =
  /** `saved` es null cuando saltó el campo trampa y no se guardó nada. */
  | { ok: true; saved: { id: string; estimate: QuoterEstimate; quoter: QuoterData } | null }
  | { ok: false; error: 'not_available' | 'invalid' | 'rate_limited' };

export async function createPremiumQuoteRequest(prisma: PrismaClient, input: PremiumQuoteInput, now: Date = new Date()): Promise<CreateQuoteResult> {
  // Al bot se le dice que ha ido bien: un error le enseñaría qué cambiar.
  if (input.trap) return { ok: true, saved: null };

  const loaded = await loadResolvedQuoter(prisma);
  if (!loaded.ok || !loaded.quoter.config.published) return { ok: false, error: 'not_available' };

  const answers = checkAnswers(loaded.quoter, input.sector, input.respuestas);
  if (!answers.ok) return { ok: false, error: 'invalid' };
  if (!(QUOTER_CALL_SLOTS as readonly string[]).includes(input.franja)) return { ok: false, error: 'invalid' };

  const since = new Date(now.getTime() - DAY_MS);
  const ipHash = hashIp(input.ip);
  const [byIp, total] = await Promise.all([
    prisma.premiumQuoteRequest.count({ where: { ipHash, createdAt: { gte: since } } }),
    prisma.premiumQuoteRequest.count({ where: { createdAt: { gte: since } } }),
  ]);
  if (byIp >= MAX_REQUESTS_PER_IP_PER_DAY || total >= MAX_REQUESTS_PER_DAY_GLOBAL) return { ok: false, error: 'rate_limited' };

  const estimate = compute(loaded.quoter, { sector: input.sector, answers: answers.answers });
  const row = await prisma.premiumQuoteRequest.create({
    data: {
      ipHash,
      contactName: input.nombre,
      company: input.empresa,
      email: input.email,
      phone: input.tel || null,
      website: input.web || null,
      callSlot: input.franja,
      sector: input.sector,
      answers: answers.answers as unknown as Prisma.InputJsonValue,
      estimate: estimate as unknown as Prisma.InputJsonValue,
      configVersion: loaded.version,
      // La hora y el texto los pone el servidor, no el formulario.
      consentAt: now,
      consentVersion: QUOTER_CONSENT.version,
    },
    select: { id: true },
  });
  return { ok: true, saved: { id: row.id, estimate, quoter: loaded.quoter } };
}

// --- La bandeja ---------------------------------------------------------------

export const PREMIUM_QUOTE_STATUSES = ['nuevo', 'contactado', 'convertido', 'descartado'] as const;
export type PremiumQuoteStatus = (typeof PREMIUM_QUOTE_STATUSES)[number];

/** Mismas transiciones que un Lead: cerrar es definitivo salvo reabrir. */
export function canMovePremiumQuote(from: string, to: PremiumQuoteStatus): boolean {
  if (from === to) return false;
  if (from === 'nuevo') return to === 'contactado' || to === 'descartado' || to === 'convertido';
  if (from === 'contactado') return to === 'convertido' || to === 'descartado';
  return to === 'contactado';
}

export type MoveQuoteResult = { ok: true } | { ok: false; error: 'not_found' | 'invalid_transition' };

export async function movePremiumQuote(
  prisma: Pick<PrismaClient, 'premiumQuoteRequest'>,
  id: string,
  to: PremiumQuoteStatus,
  operatorEmail: string | null,
  now: Date = new Date(),
): Promise<MoveQuoteResult> {
  const row = await prisma.premiumQuoteRequest.findUnique({ where: { id }, select: { status: true, contactedAt: true } });
  if (!row) return { ok: false, error: 'not_found' };
  if (!canMovePremiumQuote(row.status, to)) return { ok: false, error: 'invalid_transition' };
  await prisma.premiumQuoteRequest.update({
    where: { id },
    data: {
      status: to,
      statusChangedAt: now,
      statusChangedBy: operatorEmail,
      // Lo lee el borrado por plazo: cuenta desde el último contacto.
      contactedAt: to === 'contactado' && !row.contactedAt ? now : undefined,
    },
  });
  return { ok: true };
}

// --- El aviso al operador -----------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Best-effort: la solicitud ya está guardada, así que un correo que no sale no
 * pierde el contacto. Se queda en un `warn` y en la bandeja. Devuelve si salió.
 */
export async function notifyPremiumQuote(input: {
  id: string;
  quoter: QuoterData;
  sector: string;
  nombre: string;
  empresa: string;
  email: string;
  tel?: string;
  franja: string;
  estimate: QuoterEstimate;
}): Promise<boolean> {
  try {
    const to = await getOperatorAlertRecipients();
    const sectorName = input.quoter.sectors[input.sector]?.name ?? input.sector;
    const importe = fmt(input.quoter, input.estimate.total);
    const subject = `Presupuesto Web Premium: ${input.empresa} · ${importe}`;
    const datos = [
      `Sector: ${sectorName}`,
      `Contacto: ${input.nombre} · ${input.email}${input.tel ? ` · ${input.tel}` : ''}`,
      `Llamada: ${input.franja}`,
      `Estimación: ${importe} (${fmt(input.quoter, input.estimate.low)} – ${fmt(input.quoter, input.estimate.high)})`,
      `Servicios Kairikos: ${fmt(input.quoter, input.estimate.monthly)}/mes · Plazo: ${input.estimate.weeks} semanas`,
    ];
    const enlace = `https://portal.kairikos.cloud/admin/portal/presupuestos-premium/${input.id}`;
    const sent = await sendOperatorNotification({
      kind: 'premium-quote',
      to,
      subject,
      text: [...datos, '', enlace].join('\n'),
      html: `<p>${datos.map(escapeHtml).join('<br>')}</p><p><a href="${enlace}">Abrir en la bandeja</a></p>`,
    });
    if (!sent.ok) {
      logError('premium_quoter.notify_failed', new Error(sent.error), { id: input.id }, 'warn');
      return false;
    }
    return true;
  } catch (err) {
    logError('premium_quoter.notify_failed', err, { id: input.id }, 'warn');
    return false;
  }
}
