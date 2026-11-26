// =============================================================================
// Los plazos de los envíos al CRM y de los números de los mensajes enviados
// (lib/processor-retention.ts) contra un Postgres DE VERDAD: que Postgres
// entiende el filtro del payload vacío (jsonb), que cada pasada solo toca lo
// vencido, que lo no entregado pasa a 'expired' y ya no se puede reintentar,
// y que la segunda pasada no toca nada.
//
// Se salta sola sin PROCESSOR_RETENTION_TEST_DATABASE_URL y solo corre contra
// localhost. Cómo levantar la base: la cabecera de
// tests/real/chat-retention.test.ts (la misma receta, otra variable). Base
// vacía: la pasada recorre todas las filas, no solo las de este test.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runProcessorDataRetention } from '@/lib/processor-retention';

const URL = process.env.PROCESSOR_RETENTION_TEST_DATABASE_URL;
const isLocal = !!URL && /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(URL);

const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const RUN = `pret${Date.now().toString(36)}`;
const CLIENT = `${RUN}_c`;
const PAYLOAD = { lead: { name: 'Ana G.', phone: '+34600000001', message: 'Quiero cita' } };
const CONN = '00000000-0000-4000-8000-000000000001';

describe.skipIf(!isLocal)('plazos de los envíos al CRM y de los números, contra Postgres', () => {
  const db = new PrismaClient({ datasourceUrl: URL });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await db.chatbotClient.create({ data: { id: CLIENT, email: `${CLIENT}@example.test`, name: 'Cliente' } });
    const delivery = async (key: string, status: string, days: number, attempts = 1) => {
      const row = await db.channelWebhookDelivery.create({
        data: { connectionType: 'lead_crm', connectionId: CONN, clientId: CLIENT, payload: PAYLOAD, status, attempts, createdAt: ago(days) },
      });
      ids[key] = row.id;
    };
    await delivery('deliveredOld', 'delivered', 31);
    await delivery('skippedOld', 'skipped', 40);
    await delivery('failedOld', 'failed', 31, 6);
    await delivery('pendingOld', 'pending', 60, 0);
    await delivery('deliveredNew', 'delivered', 29);
    await delivery('failedNew', 'failed', 2, 3);

    const msg = async (key: string, days: number) => {
      const row = await db.outboundMessage.create({
        data: { clientId: CLIENT, productCode: 'recall', channel: 'whatsapp', kind: 'template', toE164: '+34600000002', ok: true, sentAt: ago(days) },
      });
      ids[key] = row.id;
    };
    await msg('msgOld', 366);
    await msg('msgNew', 300);
  });

  afterAll(async () => {
    await db.chatbotClient.deleteMany({ where: { id: CLIENT } });
    await db.$disconnect();
  });

  const delivery = (key: string) => db.channelWebhookDelivery.findUniqueOrThrow({ where: { id: ids[key] } });

  it('vacía el payload a los 30 días; lo no entregado pasa a expired; los números, a los 12 meses', async () => {
    const r = await runProcessorDataRetention(db, NOW);
    expect(r).toEqual({ webhookPayloadsCleared: 2, webhookDeliveriesExpired: 2, outboundNumbersCleared: 1 });

    for (const key of ['deliveredOld', 'skippedOld']) {
      const row = await delivery(key);
      expect(row.payload, key).toEqual({});
      expect(row.status, key).not.toBe('expired');
    }
    for (const key of ['failedOld', 'pendingOld']) {
      const row = await delivery(key);
      expect(row.payload, key).toEqual({});
      expect(row.status, key).toBe('expired');
      expect(row.lastError, key).toBe('payload_expired');
    }
    for (const key of ['deliveredNew', 'failedNew']) {
      const row = await delivery(key);
      expect(row.payload, key).toEqual(PAYLOAD);
    }
    expect((await delivery('failedNew')).status).toBe('failed');

    const old = await db.outboundMessage.findUniqueOrThrow({ where: { id: ids.msgOld } });
    expect(old.toE164).toBeNull();
    expect(old).toMatchObject({ channel: 'whatsapp', kind: 'template', ok: true });
    const recent = await db.outboundMessage.findUniqueOrThrow({ where: { id: ids.msgNew } });
    expect(recent.toE164).toBe('+34600000002');
  });

  it('la pasada siguiente no toca nada', async () => {
    const r = await runProcessorDataRetention(db, new Date(NOW.getTime() + 5 * 60_000));
    expect(r).toEqual({ webhookPayloadsCleared: 0, webhookDeliveriesExpired: 0, outboundNumbersCleared: 0 });
  });
});
