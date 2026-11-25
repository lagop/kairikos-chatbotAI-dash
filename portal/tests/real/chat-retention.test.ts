// =============================================================================
// La retención de las conversaciones del chat (lib/chat-retention.ts) contra
// un Postgres DE VERDAD.
//
// El test unitario (tests/unit/chat-retention.test.ts) mockea Prisma: dice
// qué consultas se piden, no si Postgres las entiende ni si borran lo que
// deben. Esto lo comprueba con filas reales: el corte por última actividad,
// el plazo del paso 10, que la solicitud sobrevive a su conversación (ON
// DELETE SET NULL) y que el modo de prueba no toca nada.
//
// Se salta sola sin CHAT_RETENTION_TEST_DATABASE_URL, y se niega a correr
// contra algo que no sea localhost. Usa una base VACÍA de usar y tirar: el
// modo 'purge' borra lo vencido de todos los clientes, no solo de los suyos.
//
// Cómo correrla (lo que se hizo el 25/11/2026 para el PR 4):
//
//   docker run -d --name ret-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=portal \
//     -p 55439:5432 postgres:16-alpine
//   export U=postgresql://postgres:test@127.0.0.1:55439/portal
//   DATABASE_URL=$U DIRECT_URL=$U npx prisma db push --skip-generate
//   CHAT_RETENTION_TEST_DATABASE_URL=$U npx vitest run --config vitest.real.config.ts tests/real/chat-retention.test.ts
//   docker rm -f ret-pg
//
// (`prisma db push` y no `migrate deploy`: las migraciones antiguas dan
// permisos a los roles de Supabase, que un Postgres vacío no tiene.)
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runChatRetention } from '@/lib/chat-retention';

const URL = process.env.CHAT_RETENTION_TEST_DATABASE_URL;
const isLocal = !!URL && /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(URL);

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const RUN = `ret${Date.now().toString(36)}`;
const A = `${RUN}_a`;
const B = `${RUN}_b`;
const id = (s: string) => `${RUN}_${s}`;

describe.skipIf(!isLocal)('retención del chat contra Postgres', () => {
  const prisma = new PrismaClient({ datasourceUrl: URL });

  beforeAll(async () => {
    await prisma.chatbotClient.createMany({
      data: [
        { id: A, email: `${A}@example.test`, name: 'Cliente A (60 días)' },
        { id: B, email: `${B}@example.test`, name: 'Cliente B (12 meses)' },
      ],
    });
    // Paso 10 aprobado de A, sin contratación (filas anteriores a la
    // multi-instancia): vale para sus conversaciones sin chatbot.
    await prisma.chatbotConfigStep.create({
      data: { clientId: A, stepKey: '10', status: 'approved', activeForBot: true, payload: { retencion_leads_dias: 60 } },
    });
    await prisma.chatbotConversation.createMany({
      data: [
        { id: id('a1'), clientId: A, startedAt: ago(61), duration: 60 },
        // Derivada a una persona hace 10 días: sigue viva.
        { id: id('a2'), clientId: A, startedAt: ago(61), duration: 60, handoffRequestedAt: ago(61), handoffClosedAt: ago(10) },
        // Empezó hace 90 días pero duró 40: su última actividad, hace 50.
        { id: id('a3'), clientId: A, startedAt: ago(90), duration: 40 * 24 * 3600 },
        { id: id('a4'), clientId: A, startedAt: ago(10), duration: 60 },
        { id: id('b1'), clientId: B, startedAt: ago(400), duration: 60 },
        { id: id('b2'), clientId: B, startedAt: ago(200), duration: 60 },
      ],
    });
    await prisma.lead.create({ data: { clientId: A, conversationId: id('a1'), summary: 'Pide cita' } });
    await prisma.conversationDigest.createMany({
      data: [
        { clientId: A, windowStart: ago(77), windowEnd: ago(70), totalConversations: 1, escalatedCount: 0, fallbackCount: 0, summaryText: 'a vieja' },
        { clientId: A, windowStart: ago(27), windowEnd: ago(20), totalConversations: 1, escalatedCount: 0, fallbackCount: 0, summaryText: 'a reciente' },
        { clientId: B, windowStart: ago(507), windowEnd: ago(500), totalConversations: 1, escalatedCount: 0, fallbackCount: 0, summaryText: 'b vieja' },
      ],
    });
  });

  afterAll(async () => {
    const clientId = { in: [A, B] };
    await prisma.clientDataAudit.deleteMany({ where: { clientId } });
    await prisma.lead.deleteMany({ where: { clientId } });
    await prisma.chatbotClient.deleteMany({ where: { id: clientId } });
    await prisma.$disconnect();
  });

  const remaining = async () =>
    (await prisma.chatbotConversation.findMany({ where: { clientId: { in: [A, B] } }, select: { id: true } }))
      .map((c) => c.id.replace(`${RUN}_`, ''))
      .sort();
  const digests = async () =>
    (await prisma.conversationDigest.findMany({ where: { clientId: { in: [A, B] } }, select: { summaryText: true } }))
      .map((d) => d.summaryText)
      .sort();
  const audits = (action: string) =>
    prisma.clientDataAudit.findMany({ where: { clientId: { in: [A, B] }, action }, orderBy: { clientId: 'asc' } });

  it('en modo de prueba no borra nada y deja una fila por cliente, una vez al día', async () => {
    const r = await runChatRetention(prisma, NOW, 'dry_run');
    expect(r).toMatchObject({ mode: 'dry_run', conversations: 2, digests: 2, chatbots: 2 });
    await runChatRetention(prisma, NOW, 'dry_run');

    expect(await remaining()).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2']);
    expect(await digests()).toEqual(['a reciente', 'a vieja', 'b vieja']);
    const rows = await audits('retention_dry_run');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ clientId: A, productCode: 'chatbot', actor: 'system:chat-retention' });
    expect(rows[0].metadata).toMatchObject({ count: 1, digests: 1, retentionDays: 60 });
    expect(rows[1].metadata).toMatchObject({ count: 1, digests: 1 });
    expect(rows[1].metadata).not.toHaveProperty('retentionDays');
  });

  it('al borrar: solo lo vencido por última actividad, la solicitud se queda sin conversación', async () => {
    const r = await runChatRetention(prisma, NOW, 'purge');
    expect(r).toMatchObject({ mode: 'purge', conversations: 2, digests: 2, chatbots: 2 });

    expect(await remaining()).toEqual(['a2', 'a3', 'a4', 'b2']);
    expect(await digests()).toEqual(['a reciente']);
    const lead = await prisma.lead.findFirst({ where: { clientId: A } });
    expect(lead).toMatchObject({ conversationId: null, summary: 'Pide cita' });
    const rows = await audits('retention_purged');
    expect(rows.map((x) => x.metadata)).toEqual([
      expect.objectContaining({ count: 1, digests: 1, retentionDays: 60 }),
      expect.objectContaining({ count: 1, digests: 1 }),
    ]);
  });

  it('la pasada siguiente no encuentra nada', async () => {
    const r = await runChatRetention(prisma, NOW, 'purge');
    expect(r).toMatchObject({ conversations: 0, digests: 0, chatbots: 0 });
    expect(await audits('retention_purged')).toHaveLength(2);
  });
});
