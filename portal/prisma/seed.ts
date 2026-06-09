// =============================================================================
// Kairikos — Chatbot AI portal dev/QA seed (KAIA-752)
//
// Inserts two fake clients (one Starter, one Premium) plus a few activity +
// conversation rows so the portal UI is demo-able locally and the QA
// cross-tenant isolation smoke (KAIA-725) has real rows to assert against.
//
// Run with:  npx prisma db seed
// Idempotent: re-running upserts the same rows by their unique keys
// (ChatbotClient.email, ChatbotClientUser.nextAuthEmail) and skips activities
// / conversations if a matching pair already exists.
// =============================================================================

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // ---------------------------------------------------------------------------
  // Client A — Starter tier, live, with one completed T+0 milestone.
  // ---------------------------------------------------------------------------
  const clientA = await prisma.chatbotClient.upsert({
    where: { email: 'aurora@example.com' },
    update: {},
    create: {
      email: 'aurora@example.com',
      name: 'Aurora Demo Owner',
      companyName: 'Peluquería Aurora',
      tier: 'starter',
      stripeCustomerId: 'cus_dev_aurora_0001',
      goLiveAt: new Date('2026-05-20T10:00:00Z'),
    },
  });

  await prisma.chatbotClientUser.upsert({
    where: { nextAuthEmail: 'aurora@example.com' },
    update: {},
    create: {
      nextAuthEmail: 'aurora@example.com',
      clientId: clientA.id,
    },
  });

  const auroraT0 = await prisma.chatbotActivity.findFirst({
    where: { clientId: clientA.id, milestone: 'T+0' },
  });
  if (!auroraT0) {
    await prisma.chatbotActivity.create({
      data: {
        clientId: clientA.id,
        milestone: 'T+0',
        completedAt: new Date('2026-05-20T10:00:00Z'),
        notes: 'Kickoff complete; chatbot provisioned.',
      },
    });
  }

  const auroraSampleConv = await prisma.chatbotConversation.findFirst({
    where: { clientId: clientA.id, startedAt: new Date('2026-06-08T11:00:00Z') },
  });
  if (!auroraSampleConv) {
    await prisma.chatbotConversation.create({
      data: {
        clientId: clientA.id,
        startedAt: new Date('2026-06-08T11:00:00Z'),
        duration: 142,
        outcome: 'resolved',
        transcript: [
          { role: 'user', text: '¿Habráis abierto el sábado?' },
          { role: 'bot', text: 'Sí, de 10:00 a 14:00. ¿Quieres reservar?' },
          { role: 'user', text: 'No, gracias.' },
        ],
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Client B — Premium tier, still onboarding (no goLiveAt, no T+7 yet).
  // ---------------------------------------------------------------------------
  const clientB = await prisma.chatbotClient.upsert({
    where: { email: 'rios@example.com' },
    update: {},
    create: {
      email: 'rios@example.com',
      name: 'Ríos Demo Owner',
      companyName: 'Clínica Ríos',
      tier: 'premium',
      stripeCustomerId: 'cus_dev_rios_0002',
      goLiveAt: null,
    },
  });

  await prisma.chatbotClientUser.upsert({
    where: { nextAuthEmail: 'rios@example.com' },
    update: {},
    create: {
      nextAuthEmail: 'rios@example.com',
      clientId: clientB.id,
    },
  });

  const riosT0 = await prisma.chatbotActivity.findFirst({
    where: { clientId: clientB.id, milestone: 'T+0' },
  });
  if (!riosT0) {
    await prisma.chatbotActivity.create({
      data: {
        clientId: clientB.id,
        milestone: 'T+0',
        completedAt: new Date('2026-06-01T09:00:00Z'),
        notes: 'Intake received; awaiting kickoff.',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const [clientCount, userCount, activityCount, conversationCount] = await Promise.all([
    prisma.chatbotClient.count(),
    prisma.chatbotClientUser.count(),
    prisma.chatbotActivity.count(),
    prisma.chatbotConversation.count(),
  ]);

  console.log('[prisma/seed] OK');
  console.log(`  ChatbotClient        : ${clientCount}`);
  console.log(`  ChatbotClientUser    : ${userCount}`);
  console.log(`  ChatbotActivity      : ${activityCount}`);
  console.log(`  ChatbotConversation  : ${conversationCount}`);
  console.log('  Test login emails    : aurora@example.com, rios@example.com');
}

main()
  .catch((err) => {
    console.error('[prisma/seed] FAILED', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
