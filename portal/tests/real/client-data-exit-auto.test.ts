// =============================================================================
// La baja automática de los datos de un cliente (lib/client-data-exit-auto.ts,
// PR 5b) contra un Postgres DE VERDAD: pasadas del cron una detrás de otra,
// como las haría el scheduler, y lo que queda en la base de datos después de
// cada una.
//
// Se salta sola sin CLIENT_DATA_EXIT_TEST_DATABASE_URL y solo corre contra
// localhost. Cómo levantar la base: la cabecera de
// tests/real/chat-retention.test.ts (la misma receta, otra variable). Usar una
// base vacía y correr este archivo solo: la pasada recorre TODOS los clientes
// dados de baja que encuentre.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runClientDataExits } from '@/lib/client-data-exit-auto';

const URL = process.env.CLIENT_DATA_EXIT_TEST_DATABASE_URL;
const isLocal = !!URL && /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(URL);

const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const after = (days: number) => new Date(NOW.getTime() + days * DAY);
const RUN = `auto${Date.now().toString(36)}`;
const C = `${RUN}_c`; // chat de baja, con una conversación
const D = `${RUN}_d`; // llamadas de baja, con el número todavía asignado
const E = `${RUN}_e`; // chat de baja, sin nada guardado
const F = `${RUN}_f`; // se avisó de una baja anterior, volvió y se ha vuelto a ir

const sent: string[] = [];
const alerts: string[] = [];
const opts = {
  send: async (to: string) => {
    sent.push(to);
    return { ok: true as const, messageId: 'm1' };
  },
  alert: async (msg: { subject: string; text: string }) => {
    alerts.push(msg.text);
    return { ok: true as const, messageId: 'o1' };
  },
  twilioAuth: async () => null,
};

describe.skipIf(!isLocal)('baja automática contra Postgres', () => {
  const db = new PrismaClient({ datasourceUrl: URL });
  const products: Record<string, string> = {};
  let numberId = '';

  beforeAll(async () => {
    for (const code of ['chatbot', 'recall']) {
      const p = await db.product.create({ data: { code, name: `${code} ${RUN}`, tier: `t_${RUN}`, priceCents: 0 } });
      products[code] = p.id;
    }
    await db.chatbotClient.createMany({
      data: [C, D, E, F].map((id) => ({ id, email: `${id}@example.test`, name: `Cliente ${id.slice(-1)}` })),
    });
    const cancelled = { status: 'cancelled', cancelledAt: ago(40), changedAt: ago(40) };
    for (const id of [C, E, F]) await db.clientProduct.create({ data: { clientId: id, productId: products.chatbot, ...cancelled } });
    const recallCp = await db.clientProduct.create({ data: { clientId: D, productId: products.recall, ...cancelled } });

    await db.chatbotConversation.createMany({
      data: [
        { id: `${RUN}_cc`, clientId: C, startedAt: ago(50), duration: 60 },
        { id: `${RUN}_cf`, clientId: F, startedAt: ago(50), duration: 60 },
      ],
    });
    // F: un aviso de hace 100 días, de una baja anterior a la de ahora (hace 40).
    await db.clientDataAudit.create({
      data: { clientId: F, productCode: 'chatbot', action: 'exit_notified', actor: 'system:client-data-exit', createdAt: ago(100), metadata: {} },
    });

    const sub = await db.recallSubscription.create({ data: { clientId: D, clientProductId: recallCp.id, status: 'cancelled' } });
    const n = await db.virtualNumber.create({
      data: { providerSid: `PN${RUN}`, e164: `+3401${Date.now() % 10_000_000}`, countryCode: 'ES', status: 'assigned', subscriptionId: sub.id },
    });
    numberId = n.id;
    await db.callEvent.create({
      data: { clientId: D, subscriptionId: sub.id, twilioCallSid: `CA${RUN}`, toNumber: '+34928000000', fromNumber: '+34600000009' },
    });
  });

  afterAll(async () => {
    const clientId = { in: [C, D, E, F] };
    await db.clientDataAudit.deleteMany({ where: { clientId } });
    await db.operatorNotification.deleteMany({ where: { clientId } });
    await db.virtualNumber.deleteMany({ where: { id: numberId } });
    await db.chatbotClient.deleteMany({ where: { id: clientId } });
    await db.product.deleteMany({ where: { id: { in: Object.values(products) } } });
    await db.$disconnect();
  });

  const notices = (clientId: string) => db.clientDataAudit.count({ where: { clientId, action: 'exit_notified' } });
  const purges = (clientId: string) => db.clientDataAudit.count({ where: { clientId, action: 'exit_purged' } });

  it('primera pasada: avisa a quien tiene datos, no a quien no tiene nada, y vuelve a avisar tras una baja nueva', async () => {
    const r = await runClientDataExits(db, NOW, opts);
    expect(r).toMatchObject({ notified: 3, purged: 0, problems: 0 });
    expect(sent.sort()).toEqual([`${C}@example.test`, `${D}@example.test`, `${F}@example.test`].sort());
    expect(await notices(E)).toBe(0);
    expect(await notices(F)).toBe(2);
    const row = await db.clientDataAudit.findFirst({ where: { clientId: C, action: 'exit_notified' } });
    expect(row?.actor).toBe('system:client-data-exit');
  });

  it('la pasada siguiente, el mismo día: nada (el plazo cuenta 7 días desde el aviso)', async () => {
    sent.length = 0;
    const r = await runClientDataExits(db, new Date(NOW.getTime() + 5 * 60_000), opts);
    expect(r).toMatchObject({ notified: 0, purged: 0, problems: 0 });
    expect(sent).toEqual([]);
    expect(await db.chatbotConversation.count({ where: { clientId: C } })).toBe(1);
  });

  it('pasado el plazo: borra el chat; las llamadas, con el número asignado, se paran y avisan al operador una vez al día', async () => {
    const r = await runClientDataExits(db, after(8), opts);
    expect(r).toMatchObject({ purged: 2, problems: 1, operatorAlerts: 1 });
    expect(await db.chatbotConversation.count({ where: { clientId: { in: [C, F] } } })).toBe(0);
    expect(await db.callEvent.count({ where: { clientId: D } })).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('el número sigue asignado');

    // Otra pasada el mismo día: ni se repite el borrado ni el correo al operador.
    const again = await runClientDataExits(db, new Date(after(8).getTime() + 5 * 60_000), opts);
    expect(again).toMatchObject({ notified: 0, purged: 0, operatorAlerts: 0 });
    expect(alerts).toHaveLength(1);
    expect(await purges(C)).toBe(1);
  });

  it('al día siguiente, con el número liberado: borra las llamadas, y después ya no toca a nadie', async () => {
    await db.virtualNumber.update({ where: { id: numberId }, data: { status: 'released', subscriptionId: null } });
    const r = await runClientDataExits(db, after(9), opts);
    expect(r).toMatchObject({ purged: 1, problems: 0 });
    expect(await db.callEvent.count({ where: { clientId: D } })).toBe(0);
    expect(await db.recallSubscription.count({ where: { clientId: D } })).toBe(0);

    const last = await runClientDataExits(db, after(10), opts);
    expect(last).toMatchObject({ notified: 0, purged: 0, problems: 0 });
    for (const id of [C, D, F]) expect(await purges(id)).toBe(1);
  });
});
