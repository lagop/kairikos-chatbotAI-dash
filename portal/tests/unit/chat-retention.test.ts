// =============================================================================
// Retención de las conversaciones del chat (src/lib/chat-retention.ts), PR 4
// del plan del encargo del tratamiento.
//
// Lo que se guarda aquí:
//   - borrar de más: una conversación con actividad reciente (duración larga
//     o derivación a una persona) que empezó hace mucho; un plazo de menos de
//     30 días que alguien puso por error; el modo de prueba borrando;
//   - borrar sin rastro: el borrado y su fila de ClientDataAudit van en la
//     misma transacción;
//   - ruido: en modo de prueba, una fila de auditoría por chatbot y día, no
//     una cada cinco minutos.
// Prisma va mockeado. Contra un Postgres real, tests/real/chat-retention.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const notify = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/lib/operator-notify', () => ({
  claimDailyOperatorDigest: (...a: unknown[]) => notify.claim(...a),
  releaseDailyOperatorDigest: (...a: unknown[]) => notify.release(...a),
  sendOperatorNotification: (...a: unknown[]) => notify.send(...a),
  utcDayKey: (d: Date) => d.toISOString().slice(0, 10),
}));
vi.mock('@/lib/operator-alert-settings', () => ({
  getOperatorAlertRecipients: async () => [{ email: 'ops@example.test' }],
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import {
  CHAT_RETENTION_BATCH,
  CHAT_RETENTION_MODE,
  chatRetentionCutoff,
  loadChatRetentionGroups,
  parseChatRetention,
  runChatRetention,
} from '@/lib/chat-retention';

const NOW = new Date('2027-11-25T10:00:00.000Z');
const YEAR_AGO = new Date('2026-11-25T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

type Row = {
  id: string;
  clientId: string;
  clientProductId: string | null;
  tenantId: string | null;
  startedAt: Date;
  duration: number | null;
  handoffRequestedAt: Date | null;
  handoffTakenAt: Date | null;
  handoffClosedAt: Date | null;
};
const conv = (id: string, startedAt: Date, extra: Partial<Row> = {}): Row => ({
  id,
  clientId: 'cli_a',
  clientProductId: 'cp_a',
  tenantId: 'ten_a',
  startedAt,
  duration: 60,
  handoffRequestedAt: null,
  handoffTakenAt: null,
  handoffClosedAt: null,
  ...extra,
});

const m = {
  chatbotConfigStep: { findMany: vi.fn() },
  chatbotConversation: { findMany: vi.fn(), deleteMany: vi.fn((..._a: unknown[]) => ({ op: 'conversations.deleteMany' })) },
  conversationDigest: { groupBy: vi.fn(), deleteMany: vi.fn((..._a: unknown[]) => ({ op: 'digests.deleteMany' })) },
  clientDataAudit: { findMany: vi.fn(), createMany: vi.fn((..._a: unknown[]) => ({ op: 'audit.createMany' })) },
  chatbotClient: { findMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
const prisma = m as unknown as PrismaClient;

beforeEach(() => {
  m.chatbotConfigStep.findMany.mockReset().mockResolvedValue([]);
  m.chatbotConversation.findMany.mockReset().mockResolvedValue([]);
  m.chatbotConversation.deleteMany.mockClear();
  m.conversationDigest.groupBy.mockReset().mockResolvedValue([]);
  m.conversationDigest.deleteMany.mockClear();
  m.clientDataAudit.findMany.mockReset().mockResolvedValue([]);
  m.clientDataAudit.createMany.mockClear();
  m.chatbotClient.findMany.mockReset().mockResolvedValue([{ id: 'cli_c', name: 'Clínica Corta' }]);
  m.$transaction.mockClear();
  notify.claim.mockReset().mockResolvedValue({ claimed: true, id: 'n1' });
  notify.release.mockReset();
  notify.send.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
});

describe('modo', () => {
  it('el PR 4a sale en modo de prueba: no borra nada hasta el PR 4b', () => {
    expect(CHAT_RETENTION_MODE).toBe('dry_run');
  });
});

describe('parseChatRetention (el campo «Retención» del paso 10)', () => {
  it.each([undefined, null, '', 0, '0', -5, 'abc'])('%s → 12 meses', (raw) => {
    expect(parseChatRetention(raw)).toEqual({ kind: 'default' });
  });
  it('menos de 30 días no se aplica', () => {
    expect(parseChatRetention(29)).toEqual({ kind: 'too_short', days: 29 });
    expect(parseChatRetention('7')).toEqual({ kind: 'too_short', days: 7 });
  });
  it('30 o más, en días enteros', () => {
    expect(parseChatRetention(30)).toEqual({ kind: 'days', days: 30 });
    expect(parseChatRetention(' 90 ')).toEqual({ kind: 'days', days: 90 });
    expect(parseChatRetention(45.7)).toEqual({ kind: 'days', days: 45 });
  });
});

describe('chatRetentionCutoff', () => {
  it('12 meses de calendario por defecto, también si el valor era demasiado corto', () => {
    expect(chatRetentionCutoff(NOW, { kind: 'default' }).toISOString()).toBe(YEAR_AGO.toISOString());
    expect(chatRetentionCutoff(NOW, { kind: 'too_short', days: 3 }).toISOString()).toBe(YEAR_AGO.toISOString());
  });
  it('los días del paso 10, de 24 h', () => {
    expect(chatRetentionCutoff(NOW, { kind: 'days', days: 90 }).getTime()).toBe(NOW.getTime() - 90 * DAY);
  });
  it('no muta la fecha que recibe', () => {
    const now = new Date(NOW);
    chatRetentionCutoff(now, { kind: 'default' });
    expect(now.toISOString()).toBe(NOW.toISOString());
  });
});

describe('grupos', () => {
  it('lee solo los pasos 10 aprobados del chatbot', async () => {
    await loadChatRetentionGroups(prisma, NOW);
    expect(m.chatbotConfigStep.findMany.mock.calls[0][0].where).toEqual({
      productCode: 'chatbot',
      stepKey: '10',
      activeForBot: true,
    });
  });

  it('un grupo por chatbot con días propios; las filas sin chatbot, con el plazo más largo del cliente; el resto, 12 meses', async () => {
    m.chatbotConfigStep.findMany.mockResolvedValue([
      { clientId: 'cli_a', clientProductId: 'cp_a1', payload: { retencion_leads_dias: 90 } },
      { clientId: 'cli_a', clientProductId: 'cp_a2', payload: { retencion_leads_dias: '730' } },
      { clientId: 'cli_b', clientProductId: 'cp_b', payload: { responsable_tratamiento: 'B' } },
      { clientId: 'cli_c', clientProductId: 'cp_c', payload: { retencion_leads_dias: 10 } },
    ]);
    const { groups, short } = await loadChatRetentionGroups(prisma, NOW);

    expect(short).toEqual([{ clientId: 'cli_c', clientProductId: 'cp_c', days: 10 }]);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toMatchObject({ where: { clientProductId: 'cp_a1' }, retentionDays: 90 });
    expect(groups[0].cutoff.getTime()).toBe(NOW.getTime() - 90 * DAY);
    expect(groups[1]).toMatchObject({ where: { clientProductId: 'cp_a2' }, retentionDays: 730 });
    // Las conversaciones de cli_a sin chatbot: 730 días, no 90.
    expect(groups[2]).toMatchObject({ where: { clientId: 'cli_a', clientProductId: null }, retentionDays: 730 });
    // Todo lo demás (cli_b, cli_c con su valor ignorado), 12 meses.
    expect(groups[3].cutoff.toISOString()).toBe(YEAR_AGO.toISOString());
    expect(groups[3].where).toEqual({
      NOT: {
        OR: [
          { clientProductId: { in: ['cp_a1', 'cp_a2'] } },
          { clientId: { in: ['cli_a'] }, clientProductId: null },
        ],
      },
    });
  });

  it('un cliente con un chatbot a 12 meses y otro a 90 días: sus filas sin chatbot se quedan en 12 meses', async () => {
    m.chatbotConfigStep.findMany.mockResolvedValue([
      { clientId: 'cli_a', clientProductId: 'cp_a1', payload: { retencion_leads_dias: 90 } },
      { clientId: 'cli_a', clientProductId: 'cp_a2', payload: {} },
    ]);
    const { groups } = await loadChatRetentionGroups(prisma, NOW);
    expect(groups).toHaveLength(2);
    expect(groups[1].where).toEqual({ NOT: { OR: [{ clientProductId: { in: ['cp_a1'] } }] } });
  });

  it('sin pasos 10: un solo grupo, todo a 12 meses', async () => {
    const { groups } = await loadChatRetentionGroups(prisma, NOW);
    expect(groups).toEqual([{ where: {}, cutoff: YEAR_AGO }]);
  });
});

describe('qué vence', () => {
  it('la consulta deja fuera lo que empezó o se derivó después del corte', async () => {
    await runChatRetention(prisma, NOW, 'dry_run');
    const args = m.chatbotConversation.findMany.mock.calls[0][0];
    expect(args.where.AND).toEqual([
      {},
      { startedAt: { lt: YEAR_AGO } },
      { OR: [{ handoffRequestedAt: null }, { handoffRequestedAt: { lt: YEAR_AGO } }] },
      { OR: [{ handoffTakenAt: null }, { handoffTakenAt: { lt: YEAR_AGO } }] },
      { OR: [{ handoffClosedAt: null }, { handoffClosedAt: { lt: YEAR_AGO } }] },
    ]);
    expect(args.orderBy).toEqual([{ startedAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(CHAT_RETENTION_BATCH);
    expect(m.conversationDigest.groupBy.mock.calls[0][0].where).toEqual({ AND: [{}, { windowEnd: { lt: YEAR_AGO } }] });
  });

  it('cuenta desde la última actividad: una conversación larga que acabó después del corte no vence', async () => {
    const old = new Date(YEAR_AGO.getTime() - 2 * DAY);
    m.chatbotConversation.findMany.mockResolvedValue([
      conv('c_vencida', old),
      // Empezó hace un año y dos días, pero siguió tres días más.
      conv('c_viva', old, { duration: 3 * 24 * 3600 }),
    ]);
    const r = await runChatRetention(prisma, NOW, 'purge');
    expect(r.conversations).toBe(1);
    expect(m.chatbotConversation.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c_vencida'] } } });
  });
});

describe('modo de prueba', () => {
  beforeEach(() => {
    m.chatbotConversation.findMany.mockResolvedValue([
      conv('c1', new Date('2025-01-01T00:00:00Z')),
      conv('c2', new Date('2025-02-01T00:00:00Z')),
      conv('c3', new Date('2025-03-01T00:00:00Z'), { clientId: 'cli_b', clientProductId: 'cp_b', tenantId: null }),
    ]);
    m.conversationDigest.groupBy.mockResolvedValue([{ clientId: 'cli_a', clientProductId: 'cp_a', _count: { _all: 4 } }]);
  });

  it('no borra nada, cuenta y deja una fila retention_dry_run por chatbot', async () => {
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r).toEqual({
      mode: 'dry_run',
      conversations: 3,
      digests: 4,
      chatbots: 2,
      truncated: false,
      shortRetentionIgnored: 0,
      operatorNotified: false,
    });
    expect(m.$transaction).not.toHaveBeenCalled();
    expect(m.chatbotConversation.deleteMany).not.toHaveBeenCalled();
    expect(m.conversationDigest.deleteMany).not.toHaveBeenCalled();

    const data = m.clientDataAudit.createMany.mock.calls[0][0].data;
    expect(data).toEqual([
      {
        clientId: 'cli_a',
        clientProductId: 'cp_a',
        tenantId: 'ten_a',
        productCode: 'chatbot',
        action: 'retention_dry_run',
        actor: 'system:chat-retention',
        metadata: { count: 2, digests: 4, cutoff: YEAR_AGO.toISOString() },
      },
      {
        clientId: 'cli_b',
        clientProductId: 'cp_b',
        tenantId: null,
        productCode: 'chatbot',
        action: 'retention_dry_run',
        actor: 'system:chat-retention',
        metadata: { count: 1, digests: 0, cutoff: YEAR_AGO.toISOString() },
      },
    ]);
  });

  it('una vez al día: lo ya apuntado hoy no se repite', async () => {
    m.clientDataAudit.findMany.mockResolvedValue([{ clientId: 'cli_a', clientProductId: 'cp_a' }]);
    await runChatRetention(prisma, NOW, 'dry_run');
    expect(m.clientDataAudit.findMany.mock.calls[0][0].where).toEqual({
      productCode: 'chatbot',
      action: 'retention_dry_run',
      createdAt: { gte: new Date('2027-11-25T00:00:00.000Z') },
    });
    const data = m.clientDataAudit.createMany.mock.calls[0][0].data;
    expect(data.map((d: { clientId: string }) => d.clientId)).toEqual(['cli_b']);
  });

  it('nada vencido: ni auditoría ni transacción', async () => {
    m.chatbotConversation.findMany.mockResolvedValue([]);
    m.conversationDigest.groupBy.mockResolvedValue([]);
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r.conversations).toBe(0);
    expect(m.clientDataAudit.findMany).not.toHaveBeenCalled();
    expect(m.clientDataAudit.createMany).not.toHaveBeenCalled();
  });

  it('avisa si una tanda se llena: hay más vencidas de las que cuenta', async () => {
    const old = new Date('2025-01-01T00:00:00Z');
    m.chatbotConversation.findMany.mockResolvedValue(
      Array.from({ length: CHAT_RETENTION_BATCH }, (_, i) => conv(`c${i}`, old)),
    );
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r.truncated).toBe(true);
  });
});

describe('borrado (modo del PR 4b)', () => {
  it('borra conversaciones y resúmenes vencidos y deja el rastro en la misma transacción', async () => {
    m.chatbotConversation.findMany.mockResolvedValue([conv('c1', new Date('2025-01-01T00:00:00Z'))]);
    m.conversationDigest.groupBy.mockResolvedValue([{ clientId: 'cli_a', clientProductId: 'cp_a', _count: { _all: 2 } }]);
    const r = await runChatRetention(prisma, NOW, 'purge');

    expect(r).toMatchObject({ mode: 'purge', conversations: 1, digests: 2, chatbots: 1 });
    expect(m.$transaction).toHaveBeenCalledTimes(1);
    expect(m.$transaction.mock.calls[0][0]).toEqual([
      { op: 'digests.deleteMany' },
      { op: 'conversations.deleteMany' },
      { op: 'audit.createMany' },
    ]);
    expect(m.conversationDigest.deleteMany).toHaveBeenCalledWith({ where: { AND: [{}, { windowEnd: { lt: YEAR_AGO } }] } });
    expect(m.clientDataAudit.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ action: 'retention_purged', clientId: 'cli_a', metadata: { count: 1, digests: 2, cutoff: YEAR_AGO.toISOString() } }),
    ]);
    // El rastro del modo de prueba no se escribe al borrar.
    expect(m.clientDataAudit.findMany).not.toHaveBeenCalled();
  });

  it('con días propios, el rastro lleva el plazo', async () => {
    m.chatbotConfigStep.findMany.mockResolvedValue([
      { clientId: 'cli_a', clientProductId: 'cp_a', payload: { retencion_leads_dias: 60 } },
    ]);
    m.chatbotConversation.findMany.mockImplementation(async (args: { where: { AND: [{ clientProductId?: unknown }] } }) =>
      args.where.AND[0].clientProductId === 'cp_a' ? [conv('c1', new Date(NOW.getTime() - 61 * DAY))] : [],
    );
    await runChatRetention(prisma, NOW, 'purge');
    expect(m.clientDataAudit.createMany.mock.calls[0][0].data[0].metadata).toEqual({
      count: 1,
      digests: 0,
      cutoff: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      retentionDays: 60,
    });
  });

  it('si la transacción falla, lanza (la ruta responde 500)', async () => {
    m.chatbotConversation.findMany.mockResolvedValue([conv('c1', new Date('2025-01-01T00:00:00Z'))]);
    m.$transaction.mockRejectedValueOnce(new Error('db caída'));
    await expect(runChatRetention(prisma, NOW, 'purge')).rejects.toThrow('db caída');
  });
});

describe('plazo demasiado corto', () => {
  beforeEach(() => {
    m.chatbotConfigStep.findMany.mockResolvedValue([
      { clientId: 'cli_c', clientProductId: 'cp_c', payload: { retencion_leads_dias: 7 } },
    ]);
  });

  it('se aplican 12 meses y se avisa al operador con el nombre del cliente', async () => {
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r.shortRetentionIgnored).toBe(1);
    expect(r.operatorNotified).toBe(true);
    expect(m.chatbotConversation.findMany.mock.calls[0][0].where.AND[1]).toEqual({ startedAt: { lt: YEAR_AGO } });
    expect(notify.claim.mock.calls[0][1]).toMatchObject({ kind: 'chat-retention-short', day: '2027-11-25' });
    const sent = notify.send.mock.calls[0][0];
    expect(sent.kind).toBe('chat-retention-short');
    expect(sent.to).toEqual([{ email: 'ops@example.test' }]);
    expect(sent.text).toContain('- Clínica Corta: 7 días');
  });

  it('una vez al día: si ya se mandó, no se manda otra vez', async () => {
    notify.claim.mockResolvedValue({ claimed: false });
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r.operatorNotified).toBe(false);
    expect(notify.send).not.toHaveBeenCalled();
  });

  it('si el correo falla, suelta el día para reintentarlo y no tumba la pasada', async () => {
    notify.send.mockResolvedValue({ ok: false, error: 'resend caído' });
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r.operatorNotified).toBe(false);
    expect(notify.release).toHaveBeenCalledWith(prisma, 'n1');
  });

  it('si la base de datos falla al avisar, tampoco', async () => {
    notify.claim.mockRejectedValue(new Error('db caída'));
    await expect(runChatRetention(prisma, NOW, 'dry_run')).resolves.toMatchObject({ operatorNotified: false });
  });
});
