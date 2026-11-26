import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { recordClientDataAudit, type ClientDataProductCode } from './client-data-audit';
import { announcedGraceEnd, serviceState, type ContractForExit, type ServiceState } from './villas/exit-rules';
import { deleteTwilioRecording } from './recall-retention';
import { portalBaseUrl } from './portal-base-url';
import { sendCarteraEmail, type SendResult } from './cartera/emails';

// =============================================================================
// RGPD, encargo del tratamiento — PR 5a del plan (25/11/2026): la baja de los
// datos que Kairikos trata por cuenta del cliente en el chat, las llamadas y
// las solicitudes. Procedimiento: docs/runbooks/baja-datos-cliente.md.
//
// Desde el PR 5b (26/11/2026) lo hace solo el cron, como villas y cartera
// (lib/client-data-exit-auto.ts). El operador puede hacer lo mismo a mano,
// por cliente y producto, con scripts/baja-datos-cliente.sh. Tres pasos, en
// este orden:
//
//   estado  — qué hay, en qué punto está la baja y qué la bloquea. No escribe.
//   avisar  — correo al cliente con el plazo y dónde exportar; deja la fila
//             `exit_notified` en ClientDataAudit, que es la que cuenta como
//             aviso. Solo con todas las contrataciones del producto dadas de
//             baja.
//   borrar  — sin `confirm`, dice lo que borraría (modo de prueba). Con
//             `confirm`, borra y deja `exit_purged`. Solo pasado el plazo.
//
// LAS REGLAS DE PLAZO son las de villas y cartera (lib/villas/exit-rules.ts):
// 30 días desde la baja, y nunca menos de 7 desde el aviso. Sin aviso no se
// borra nunca.
//
// QUÉ CONTRATACIONES DECIDEN:
//   - chatbot: las de `chatbot`.
//   - recall: las de `recall`.
//   - leads: las de todo lo que genera solicitudes —chatbot, recall,
//     prospecting, cartera— y `leads`. Mientras una siga sin dar de baja, las
//     solicitudes se quedan: son del buzón que el cliente sigue usando.
// Si el cliente tiene dos contrataciones del mismo producto y solo da de baja
// una, no se puede usar esto (sus datos no se separan por contratación en
// todas las tablas): se bloquea y se resuelve a mano.
//
// QUÉ SE BORRA, y qué no:
//   - chatbot: conversaciones, sus resúmenes y los mensajes salientes del
//     chat. Las solicitudes que salieron de ellas se quedan (SET NULL).
//   - recall: primero, en Twilio, las grabaciones que queden; si falla una,
//     no se borra nada aquí. Después la suscripción de llamadas entera
//     (llamadas, transcripciones, citas, presupuestos, bloqueos, resúmenes,
//     saludo grabado: todo cae en cascada) y sus mensajes salientes. No se
//     borra con un número todavía asignado: se libera antes, desde el admin.
//   - leads: solicitudes, su auditoría y los mensajes salientes de captación
//     y prospección.
//   - En los tres, los contactos (Contact) que se quedan sin nada que los
//     use.
//   No se toca la configuración del negocio ni la contratación, ni la
//   facturación: no son datos de terceros, y la contratación es el rastro de
//   que hubo servicio.
// =============================================================================

export const EXIT_PRODUCTS = ['chatbot', 'recall', 'leads'] as const satisfies readonly ClientDataProductCode[];
export type ExitProduct = (typeof EXIT_PRODUCTS)[number];

export function isExitProduct(value: unknown): value is ExitProduct {
  return typeof value === 'string' && (EXIT_PRODUCTS as readonly string[]).includes(value);
}

/** Las contrataciones que tienen que estar dadas de baja para cada producto. */
export const EXIT_CONTRACT_CODES: Record<ExitProduct, readonly string[]> = {
  chatbot: ['chatbot'],
  recall: ['recall'],
  leads: ['leads', 'prospecting', 'chatbot', 'recall', 'cartera'],
};

/** Mensajes salientes (OutboundMessage.productCode) que caen con cada producto. */
const OUTBOUND_CODES: Record<ExitProduct, readonly string[]> = {
  chatbot: ['chatbot'],
  recall: ['recall'],
  leads: ['leads', 'prospecting'],
};

/** Dónde exporta el cliente lo de cada producto (ver docs/datos-de-clientes-rgpd.md). */
const EXPORT_PATH: Record<ExitProduct, string> = {
  chatbot: '/portal/conversations',
  recall: '/portal/llamadas',
  leads: '/portal/leads',
};

const PRODUCT_LABEL: Record<ExitProduct, { name: string; data: string }> = {
  chatbot: { name: 'el chat', data: 'las conversaciones del chat' },
  recall: { name: 'la recuperación de llamadas', data: 'el registro de llamadas, con sus transcripciones' },
  leads: { name: 'la captación de solicitudes', data: 'las solicitudes' },
};

export interface ExitCounts {
  conversations?: number;
  digests?: number;
  calls?: number;
  /** Grabaciones que siguen en Twilio. */
  recordings?: number;
  /** Números virtuales todavía asignados a una suscripción del cliente. */
  assignedNumbers?: number;
  leads?: number;
  outboundMessages: number;
}

export type ExitBlocker =
  | 'client_not_found'
  | 'no_contract'
  | 'contract_not_cancelled'
  | 'not_notified'
  | 'grace_not_over'
  | 'number_still_assigned'
  | 'twilio_not_configured';

export interface ExitStatus {
  clientId: string;
  product: ExitProduct;
  /** Las contrataciones que deciden, con su estado. */
  contracts: { id: string; code: string; status: string; cancelledAt: string | null }[];
  /** 'none' sin contrataciones; si no, el de exit-rules. */
  state: ServiceState | 'none';
  /** El aviso de esta baja: solo cuenta uno posterior a la última baja (si el
   *  cliente reactivó y volvió a darse de baja, se avisa otra vez). */
  notifiedAt: string | null;
  /** Si los datos de esta baja ya se borraron (`exit_purged` posterior a la
   *  última baja). El cron no vuelve a tocarla. */
  purgedAt: string | null;
  graceEndsAt: string | null;
  counts: ExitCounts;
  /** Lo que impide avisar (si aún no se avisó) o borrar (si ya se avisó). */
  blockers: ExitBlocker[];
}

type Db = PrismaClient;

interface LoadedExit {
  client: { id: string; email: string; name: string; companyName: string | null; tenantId: string | null } | null;
  contract: ContractForExit | null;
  status: ExitStatus;
  subscriptionIds: string[];
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

async function countData(db: Db, clientId: string, product: ExitProduct, subscriptionIds: string[]): Promise<ExitCounts> {
  const outboundMessages = await db.outboundMessage.count({ where: { clientId, productCode: { in: [...OUTBOUND_CODES[product]] } } });
  if (product === 'chatbot') {
    const [conversations, digests] = await Promise.all([
      db.chatbotConversation.count({ where: { clientId } }),
      db.conversationDigest.count({ where: { clientId } }),
    ]);
    return { conversations, digests, outboundMessages };
  }
  if (product === 'recall') {
    const [calls, recordings, assignedNumbers] = await Promise.all([
      db.callEvent.count({ where: { clientId } }),
      db.callEvent.count({ where: { clientId, recordingSid: { not: null }, recordingDeletedAt: null } }),
      subscriptionIds.length > 0 ? db.virtualNumber.count({ where: { subscriptionId: { in: subscriptionIds } } }) : Promise.resolve(0),
    ]);
    return { calls, recordings, assignedNumbers, outboundMessages };
  }
  const leads = await db.lead.count({ where: { clientId } });
  return { leads, outboundMessages };
}

/** El punto en que está la baja. No escribe nada. */
export async function loadExit(db: Db, clientId: string, product: ExitProduct, now: Date): Promise<LoadedExit> {
  const client = await db.chatbotClient.findUnique({
    where: { id: clientId },
    select: { id: true, email: true, name: true, companyName: true, tenantId: true },
  });
  const empty: ExitStatus = {
    clientId,
    product,
    contracts: [],
    state: 'none',
    notifiedAt: null,
    purgedAt: null,
    graceEndsAt: null,
    counts: { outboundMessages: 0 },
    blockers: ['client_not_found'],
  };
  if (!client) return { client: null, contract: null, status: empty, subscriptionIds: [] };

  const [contracts, notice, purge, subscriptions] = await Promise.all([
    db.clientProduct.findMany({
      where: { clientId, product: { code: { in: [...EXIT_CONTRACT_CODES[product]] } } },
      select: { id: true, status: true, cancelledAt: true, changedAt: true, product: { select: { code: true } } },
      orderBy: { subscribedAt: 'asc' },
    }),
    db.clientDataAudit.findFirst({
      where: { clientId, productCode: product, action: 'exit_notified' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    db.clientDataAudit.findFirst({
      where: { clientId, productCode: product, action: 'exit_purged' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    product === 'recall' ? db.recallSubscription.findMany({ where: { clientId }, select: { id: true } }) : Promise.resolve([]),
  ]);
  const subscriptionIds = subscriptions.map((s) => s.id);
  const counts = await countData(db, clientId, product, subscriptionIds);

  const blockers: ExitBlocker[] = [];
  let state: ExitStatus['state'] = 'none';
  let contract: ContractForExit | null = null;
  let graceEnds: Date | null = null;
  let notifiedAt: Date | null = null;
  let purgedAt: Date | null = null;

  if (contracts.length === 0) {
    blockers.push('no_contract');
  } else if (contracts.some((c) => c.status !== 'cancelled')) {
    state = contracts.some((c) => c.status === 'active') ? 'active' : 'suspended';
    blockers.push('contract_not_cancelled');
  } else {
    // La baja más reciente es la que cuenta: el plazo no puede acabar antes
    // de 30 días desde la última contratación que se cerró.
    const since = (c: (typeof contracts)[number]) => (c.cancelledAt ?? c.changedAt).getTime();
    const latest = contracts.reduce((a, b) => (since(b) > since(a) ? b : a));
    contract = { status: latest.status, cancelledAt: latest.cancelledAt, changedAt: latest.changedAt };
    // Un aviso o un borrado de una baja anterior (el cliente volvió y se ha
    // vuelto a ir) no valen para esta.
    const cycle = since(latest);
    if (notice && notice.createdAt.getTime() >= cycle) notifiedAt = notice.createdAt;
    if (purge && purge.createdAt.getTime() >= cycle) purgedAt = purge.createdAt;
    const s = serviceState(contract, notifiedAt, now);
    state = s.state;
    graceEnds = notifiedAt ? s.graceEndsAt : announcedGraceEnd(contract, now);
    if (notifiedAt && s.state !== 'closed') blockers.push('grace_not_over');
  }
  if (!notifiedAt && contracts.length > 0 && !blockers.includes('contract_not_cancelled')) blockers.push('not_notified');
  if (product === 'recall' && (counts.assignedNumbers ?? 0) > 0) blockers.push('number_still_assigned');

  return {
    client,
    contract,
    subscriptionIds,
    status: {
      clientId,
      product,
      contracts: contracts.map((c) => ({ id: c.id, code: c.product.code, status: c.status, cancelledAt: isoOrNull(c.cancelledAt) })),
      state,
      notifiedAt: isoOrNull(notifiedAt),
      purgedAt: isoOrNull(purgedAt),
      graceEndsAt: isoOrNull(graceEnds),
      counts,
      blockers,
    },
  };
}

export function renderExitNoticeEmail(info: {
  clientName: string;
  product: ExitProduct;
  graceEndsAt: Date;
  counts: ExitCounts;
}): { subject: string; text: string; html: string } {
  const label = PRODUCT_LABEL[info.product];
  const deadline = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(info.graceEndsAt);
  const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' }).format(info.graceEndsAt);
  const link = `${portalBaseUrl()}${EXPORT_PATH[info.product]}`;
  const paragraphs = [
    `Hola, ${info.clientName}:`,
    `Has dado de baja ${label.name}. Como encargados del tratamiento, guardamos ${label.data} hasta el ${deadline}. Ese día las borramos del todo y no se pueden recuperar.`,
    `Antes de esa fecha puedes descargarlas en CSV o JSON desde tu portal, aunque el servicio ya no esté activo: ${link}`,
    'Si es un error o quieres conservarlas más tiempo, contesta a este correo antes de esa fecha.',
  ];
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    subject: `Tus datos de ${label.name} se borran el ${day}: descárgalos antes`,
    text: paragraphs.join('\n\n'),
    html: paragraphs.map((p) => `<p>${escape(p).replace(escape(link), `<a href="${escape(link)}">${escape(link)}</a>`)}</p>`).join('\n'),
  };
}

export type ExitActionResult =
  | { ok: true; status: ExitStatus; done: 'notified' | 'purged' | 'dry_run'; recordingsDeleted?: number }
  | { ok: false; status: ExitStatus; error: ExitBlocker | 'already_notified' | 'email_failed' | 'twilio_failed'; detail?: string };

/** Quién hace la baja en la auditoría: `operator:<email>` (el script) o
 *  `system:client-data-exit` (el cron). */
export type ExitActor = `operator:${string}` | `system:${string}`;

/** El aviso al cliente. Se manda primero y se apunta después: sin correo
 *  entregado a Resend no hay aviso, y el plazo no empieza a contar. */
export async function notifyExit(
  db: Db,
  clientId: string,
  product: ExitProduct,
  actor: ExitActor,
  now: Date = new Date(),
  opts: { send?: (to: string, email: { subject: string; text: string; html: string }) => Promise<SendResult> } = {},
): Promise<ExitActionResult> {
  const { client, contract, status } = await loadExit(db, clientId, product, now);
  if (status.notifiedAt) return { ok: false, status, error: 'already_notified' };
  const hard = status.blockers.filter((b) => b !== 'not_notified' && b !== 'number_still_assigned');
  if (!client || !contract || hard.length > 0) return { ok: false, status, error: hard[0] ?? 'no_contract' };

  const graceEnds = announcedGraceEnd(contract, now);
  const email = renderExitNoticeEmail({
    clientName: client.companyName?.trim() || client.name.trim() || 'cliente',
    product,
    graceEndsAt: graceEnds,
    counts: status.counts,
  });
  const send = opts.send ?? ((to, e) => sendCarteraEmail(to, e));
  const sent = await send(client.email, email);
  if (!sent.ok || 'skipped' in sent) {
    return { ok: false, status, error: 'email_failed', detail: sent.ok ? sent.reason : sent.error };
  }

  await recordClientDataAudit(db, {
    clientId,
    tenantId: client.tenantId,
    productCode: product,
    action: 'exit_notified',
    actor,
    metadata: { noticeAt: now.toISOString(), cutoff: graceEnds.toISOString(), count: mainCount(product, status.counts) },
  });
  return { ok: true, done: 'notified', status: { ...status, notifiedAt: now.toISOString(), graceEndsAt: graceEnds.toISOString(), blockers: [] } };
}

function mainCount(product: ExitProduct, counts: ExitCounts): number {
  if (product === 'chatbot') return counts.conversations ?? 0;
  if (product === 'recall') return counts.calls ?? 0;
  return counts.leads ?? 0;
}

/** Contactos sin nada que los use: ni solicitudes, ni llamadas, ni citas,
 *  presupuestos, campañas o borradores. */
const ORPHAN_CONTACT = (clientId: string): Prisma.ContactWhereInput => ({
  clientId,
  leads: { none: {} },
  callEvents: { none: {} },
  jobs: { none: {} },
  serviceQuotes: { none: {} },
  recoveryCampaignMembers: { none: {} },
  jobCaptureDrafts: { none: {} },
});

/**
 * El borrado. Sin `confirm`, el modo de prueba: devuelve lo que borraría y
 * no escribe nada. Con `confirm`, solo si no queda ningún bloqueo.
 */
export async function purgeExit(
  db: Db,
  clientId: string,
  product: ExitProduct,
  actor: ExitActor,
  confirm: boolean,
  now: Date = new Date(),
  opts: { twilioAuth?: () => Promise<{ accountSid: string; authToken: string } | null> } = {},
): Promise<ExitActionResult> {
  const { client, status, subscriptionIds } = await loadExit(db, clientId, product, now);
  if (!client || status.blockers.length > 0) {
    return confirm ? { ok: false, status, error: status.blockers[0] ?? 'client_not_found' } : { ok: true, done: 'dry_run', status };
  }
  if (!confirm) return { ok: true, done: 'dry_run', status };

  let recordingsDeleted = 0;
  if (product === 'recall' && (status.counts.recordings ?? 0) > 0) {
    const auth = opts.twilioAuth ? await opts.twilioAuth() : null;
    if (!auth) return { ok: false, status, error: 'twilio_not_configured' };
    const rows = await db.callEvent.findMany({
      where: { clientId, recordingSid: { not: null }, recordingDeletedAt: null },
      select: { id: true, recordingSid: true },
    });
    // Allí primero y aquí después, como recall-retention.ts. Si una falla,
    // no se borra nada en la base de datos: la llamada sigue diciendo qué
    // grabación queda en Twilio, y la siguiente vuelta la reintenta.
    for (const row of rows) {
      const res = await deleteTwilioRecording(row.recordingSid!, auth);
      if (!res.ok) return { ok: false, status, error: 'twilio_failed', detail: `${row.recordingSid}: ${res.error}` };
      await db.callEvent.update({ where: { id: row.id }, data: { recordingDeletedAt: now, recordingUrl: null } });
      recordingsDeleted += 1;
    }
  }

  const outbound = { clientId, productCode: { in: [...OUTBOUND_CODES[product]] } };
  await db.$transaction(async (tx) => {
    // Primero el rastro: en la misma transacción, así que no hay borrado sin
    // rastro ni rastro de un borrado que no pasó.
    await recordClientDataAudit(tx, {
      clientId,
      tenantId: client.tenantId,
      productCode: product,
      action: 'exit_purged',
      actor,
      metadata: {
        count: mainCount(product, status.counts),
        ...(product === 'chatbot' ? { digests: status.counts.digests } : {}),
        noticeAt: status.notifiedAt ?? undefined,
        cutoff: status.graceEndsAt ?? undefined,
      },
    });
    await tx.outboundMessage.deleteMany({ where: outbound });
    if (product === 'chatbot') {
      await tx.conversationDigest.deleteMany({ where: { clientId } });
      await tx.chatbotConversation.deleteMany({ where: { clientId } });
    } else if (product === 'recall') {
      // Llamadas, citas, presupuestos, bloqueos, resúmenes, uso y el saludo
      // grabado caen en cascada con la suscripción.
      await tx.recallSubscription.deleteMany({ where: { id: { in: subscriptionIds } } });
    } else {
      // LeadAudit apunta al lead con onDelete: Restrict, a propósito (ver
      // retention-purge.ts): aquí borrar es la finalidad.
      await tx.leadAudit.deleteMany({ where: { clientId } });
      await tx.lead.deleteMany({ where: { clientId } });
    }
    await tx.contact.deleteMany({ where: ORPHAN_CONTACT(clientId) });
  });

  return { ok: true, done: 'purged', status, ...(product === 'recall' ? { recordingsDeleted } : {}) };
}
