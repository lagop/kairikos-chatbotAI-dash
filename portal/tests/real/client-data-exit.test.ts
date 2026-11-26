// =============================================================================
// La baja de los datos de un cliente (lib/client-data-exit.ts, PR 5a) contra
// un Postgres DE VERDAD: que Postgres acepta los borrados en el orden en que
// se hacen (LeadAudit con Restrict, cascadas de la suscripción de llamadas,
// SET NULL de las solicitudes) y que no se lleva nada de otro cliente.
//
// Se salta sola sin CLIENT_DATA_EXIT_TEST_DATABASE_URL y solo corre contra
// localhost. Cómo levantar la base: la cabecera de
// tests/real/chat-retention.test.ts (la misma receta, otra variable).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { loadExit, notifyExit, purgeExit } from '@/lib/client-data-exit';

const URL = process.env.CLIENT_DATA_EXIT_TEST_DATABASE_URL;
const isLocal = !!URL && /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(URL);

const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const RUN = `exit${Date.now().toString(36)}`;
const A = `${RUN}_a`; // se da de baja
const B = `${RUN}_b`; // otro cliente: no se toca
const sent: string[] = [];
const send = async (to: string) => {
  sent.push(to);
  return { ok: true as const, messageId: 'm1' };
};

describe.skipIf(!isLocal)('baja de datos contra Postgres', () => {
  const db = new PrismaClient({ datasourceUrl: URL });
  const products: Record<string, string> = {};
  let subA = '';
  let numberId = '';

  beforeAll(async () => {
    for (const code of ['chatbot', 'recall', 'leads', 'prospecting', 'cartera']) {
      const p = await db.product.create({ data: { code, name: `${code} ${RUN}`, tier: `t_${RUN}`, priceCents: 0 } });
      products[code] = p.id;
    }
    await db.chatbotClient.createMany({
      data: [
        { id: A, email: `${A}@example.test`, name: 'Cliente A' },
        { id: B, email: `${B}@example.test`, name: 'Cliente B' },
      ],
    });
    // A: chat y llamadas de baja hace 40 días; captación todavía activa.
    const cancelled = { status: 'cancelled', cancelledAt: ago(40), changedAt: ago(40) };
    await db.clientProduct.create({ data: { clientId: A, productId: products.chatbot, ...cancelled } });
    const recallCp = await db.clientProduct.create({ data: { clientId: A, productId: products.recall, ...cancelled } });
    await db.clientProduct.create({ data: { clientId: A, productId: products.leads, status: 'active' } });
    await db.clientProduct.create({ data: { clientId: B, productId: products.chatbot, ...cancelled } });

    await db.chatbotConversation.createMany({
      data: [
        { id: `${RUN}_ca`, clientId: A, startedAt: ago(50), duration: 60 },
        { id: `${RUN}_cb`, clientId: B, startedAt: ago(50), duration: 60 },
      ],
    });
    await db.conversationDigest.create({
      data: { clientId: A, windowStart: ago(57), windowEnd: ago(50), totalConversations: 1, escalatedCount: 0, fallbackCount: 0, summaryText: 'a' },
    });
    const sub = await db.recallSubscription.create({ data: { clientId: A, clientProductId: recallCp.id, status: 'cancelled' } });
    subA = sub.id;
    const n = await db.virtualNumber.create({
      data: { providerSid: `PN${RUN}`, e164: `+3400${Date.now() % 10_000_000}`, countryCode: 'ES', status: 'assigned', subscriptionId: subA },
    });
    numberId = n.id;
    const contactCall = await db.contact.create({ data: { clientId: A, e164: '+34600000001', source: 'call', firstSeenAt: ago(50), lastInteractionAt: ago(50) } });
    const contactLead = await db.contact.create({ data: { clientId: A, e164: '+34600000002', source: 'chat', firstSeenAt: ago(50), lastInteractionAt: ago(50) } });
    // Grabación ya borrada en Twilio: así la prueba no llama a Twilio.
    await db.callEvent.create({
      data: { clientId: A, subscriptionId: subA, twilioCallSid: `CA${RUN}`, toNumber: '+34928000000', fromNumber: '+34600000001', contactId: contactCall.id, recordingSid: `RE${RUN}`, recordingDeletedAt: ago(10) },
    });
    await db.outboundMessage.createMany({
      data: [
        { clientId: A, productCode: 'recall', channel: 'whatsapp', kind: 'caller_notify', toE164: '+34600000001', ok: true },
        { clientId: A, productCode: 'chatbot', channel: 'whatsapp', kind: 'reply', toE164: '+34600000003', ok: true },
        { clientId: A, productCode: 'leads', channel: 'whatsapp', kind: 'outreach', toE164: '+34600000002', ok: true },
      ],
    });
    const lead = await db.lead.create({ data: { clientId: A, conversationId: `${RUN}_ca`, contactId: contactLead.id, summary: 'Pide cita' } });
    await db.leadAudit.create({ data: { leadId: lead.id, clientId: A, action: 'created', actorId: 'test' } });
  });

  afterAll(async () => {
    const clientId = { in: [A, B] };
    await db.clientDataAudit.deleteMany({ where: { clientId } });
    await db.leadAudit.deleteMany({ where: { clientId } });
    await db.lead.deleteMany({ where: { clientId } });
    await db.virtualNumber.deleteMany({ where: { id: numberId } });
    await db.chatbotClient.deleteMany({ where: { id: clientId } });
    await db.product.deleteMany({ where: { id: { in: Object.values(products) } } });
    await db.$disconnect();
  });

  it('estado: sin aviso no se borra, y la captación activa bloquea las solicitudes', async () => {
    const chat = await loadExit(db, A, 'chatbot', NOW);
    expect(chat.status).toMatchObject({ state: 'grace', notifiedAt: null, blockers: ['not_notified'] });
    expect(chat.status.counts).toEqual({ conversations: 1, digests: 1, outboundMessages: 1 });
    const leads = await loadExit(db, A, 'leads', NOW);
    expect(leads.status.blockers).toContain('contract_not_cancelled');
    const recall = await loadExit(db, A, 'recall', NOW);
    expect(recall.status.blockers).toEqual(['not_notified', 'number_still_assigned']);
    expect(recall.status.counts).toMatchObject({ calls: 1, recordings: 0, assignedNumbers: 1 });
  });

  it('avisar: manda el correo, deja exit_notified y no avisa dos veces', async () => {
    const r = await notifyExit(db, A, 'chatbot', 'operator:ops@example.test', NOW, { send });
    expect(r.ok).toBe(true);
    expect(sent).toEqual([`${A}@example.test`]);
    const again = await notifyExit(db, A, 'chatbot', 'operator:ops@example.test', NOW, { send });
    expect(again).toMatchObject({ ok: false, error: 'already_notified' });
    const rows = await db.clientDataAudit.findMany({ where: { clientId: A, action: 'exit_notified' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productCode: 'chatbot', actor: 'operator:ops@example.test' });
  });

  it('borrar antes de 7 días desde el aviso: bloqueado, aunque la baja fue hace 40', async () => {
    const r = await purgeExit(db, A, 'chatbot', 'operator:ops@example.test', true, NOW);
    expect(r).toMatchObject({ ok: false, error: 'grace_not_over' });
    expect(await db.chatbotConversation.count({ where: { clientId: A } })).toBe(1);
  });

  it('pasado el plazo: modo de prueba sin tocar nada, y con confirmar borra solo lo del chat de A', async () => {
    const later = new Date(NOW.getTime() + 8 * DAY);
    const dry = await purgeExit(db, A, 'chatbot', 'operator:ops@example.test', false, later);
    expect(dry).toMatchObject({ ok: true, done: 'dry_run' });
    expect(await db.chatbotConversation.count({ where: { clientId: A } })).toBe(1);

    const r = await purgeExit(db, A, 'chatbot', 'operator:ops@example.test', true, later);
    expect(r).toMatchObject({ ok: true, done: 'purged' });
    expect(await db.chatbotConversation.count({ where: { clientId: A } })).toBe(0);
    expect(await db.conversationDigest.count({ where: { clientId: A } })).toBe(0);
    expect(await db.outboundMessage.count({ where: { clientId: A, productCode: 'chatbot' } })).toBe(0);
    // Lo demás sigue: la solicitud (sin conversación), las llamadas, el otro cliente.
    expect(await db.lead.findFirst({ where: { clientId: A } })).toMatchObject({ conversationId: null, summary: 'Pide cita' });
    expect(await db.outboundMessage.count({ where: { clientId: A } })).toBe(2);
    expect(await db.callEvent.count({ where: { clientId: A } })).toBe(1);
    expect(await db.chatbotConversation.count({ where: { clientId: B } })).toBe(1);
    const audit = await db.clientDataAudit.findFirst({ where: { clientId: A, action: 'exit_purged' } });
    expect(audit?.metadata).toMatchObject({ count: 1, digests: 1 });
  });

  it('llamadas: con el número asignado no se borra; liberado, cae la suscripción entera y el contacto huérfano', async () => {
    const later = new Date(NOW.getTime() + 8 * DAY);
    await notifyExit(db, A, 'recall', 'operator:ops@example.test', NOW, { send });
    const blocked = await purgeExit(db, A, 'recall', 'operator:ops@example.test', true, later);
    expect(blocked).toMatchObject({ ok: false, error: 'number_still_assigned' });

    await db.virtualNumber.update({ where: { id: numberId }, data: { status: 'released', subscriptionId: null } });
    const r = await purgeExit(db, A, 'recall', 'operator:ops@example.test', true, later);
    expect(r).toMatchObject({ ok: true, done: 'purged', recordingsDeleted: 0 });
    expect(await db.recallSubscription.count({ where: { clientId: A } })).toBe(0);
    expect(await db.callEvent.count({ where: { clientId: A } })).toBe(0);
    expect(await db.outboundMessage.count({ where: { clientId: A, productCode: 'recall' } })).toBe(0);
    // El contacto de la llamada se queda sin nada y cae; el de la solicitud sigue.
    expect((await db.contact.findMany({ where: { clientId: A }, select: { e164: true } })).map((c) => c.e164)).toEqual(['+34600000002']);
  });

  it('solicitudes: al dar de baja la captación, se borran con su auditoría y su contacto', async () => {
    await db.clientProduct.updateMany({ where: { clientId: A, productId: products.leads }, data: { status: 'cancelled', cancelledAt: ago(40), changedAt: ago(40) } });
    const later = new Date(NOW.getTime() + 8 * DAY);
    await notifyExit(db, A, 'leads', 'operator:ops@example.test', NOW, { send });
    const r = await purgeExit(db, A, 'leads', 'operator:ops@example.test', true, later);
    expect(r).toMatchObject({ ok: true, done: 'purged' });
    expect(await db.lead.count({ where: { clientId: A } })).toBe(0);
    expect(await db.leadAudit.count({ where: { clientId: A } })).toBe(0);
    expect(await db.contact.count({ where: { clientId: A } })).toBe(0);
    expect(await db.outboundMessage.count({ where: { clientId: A } })).toBe(0);
    expect(await db.clientDataAudit.count({ where: { clientId: A, action: 'exit_purged' } })).toBe(3);
  });
});
