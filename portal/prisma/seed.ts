// =============================================================================
// Kairikos — Chatbot AI portal dev/QA seed (KAIA-752, KAIA-2103)
//
// Inserts two fake clients (one Starter, one Premium) plus a few activity +
// conversation rows so the portal UI is demo-able locally and the QA
// cross-tenant isolation smoke (KAIA-725) has real rows to assert against.
//
// KAIA-2103: each ChatbotClientUser is now linked to a User row. The seed
// creates the User rows with a dev password hash so local login works.
//
// Run with:  npx prisma db seed
// Idempotent: re-running upserts the same rows by their unique keys
// (ChatbotClient.email, ChatbotClientUser.nextAuthEmail, User.email) and
// skips activities / conversations if a matching pair already exists.
// =============================================================================

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Dev-only password hash for seed users. DO NOT use in production.
// Hash of 'devpassword123' using argon2id.
const DEV_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$QU5FRC5BTi80SjZSdVBFQQ$CfJqKkKj7mJ9xLs1pVnI8hKmN3oR4tW6yB2cD4eF0g';

async function main() {
  // ---------------------------------------------------------------------------
  // lucia operator (KAIA-2103) — the default admin account.
  // passwordHash='__must_reset__' blocks login until the operator completes
  // the setup-password flow. In dev, you can update this to DEV_PASSWORD_HASH
  // to enable login without email verification.
  // ---------------------------------------------------------------------------
  await prisma.operator.upsert({
    where: { email: 'lucia@kairikos.com' },
    update: {},
    create: {
      email: 'lucia@kairikos.com',
      passwordHash: '__must_reset__',
    },
  });

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

  const userA = await prisma.user.upsert({
    where: { email: 'aurora@example.com' },
    update: {},
    create: {
      email: 'aurora@example.com',
      role: 'client',
      passwordHash: DEV_PASSWORD_HASH,
      passwordSetAt: new Date('2026-05-01T00:00:00Z'),
    },
  });

  await prisma.chatbotClientUser.upsert({
    where: { nextAuthEmail: 'aurora@example.com' },
    update: { userId: userA.id },
    create: {
      nextAuthEmail: 'aurora@example.com',
      clientId: clientA.id,
      userId: userA.id,
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

  const userB = await prisma.user.upsert({
    where: { email: 'rios@example.com' },
    update: {},
    create: {
      email: 'rios@example.com',
      role: 'client',
      passwordHash: DEV_PASSWORD_HASH,
      passwordSetAt: new Date('2026-06-01T00:00:00Z'),
    },
  });

  await prisma.chatbotClientUser.upsert({
    where: { nextAuthEmail: 'rios@example.com' },
    update: { userId: userB.id },
    create: {
      nextAuthEmail: 'rios@example.com',
      clientId: clientB.id,
      userId: userB.id,
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
  const [clientCount, userCount, operatorCount, activityCount, conversationCount] = await Promise.all([
    prisma.chatbotClient.count(),
    prisma.user.count(),
    prisma.operator.count(),
    prisma.chatbotActivity.count(),
    prisma.chatbotConversation.count(),
  ]);

  console.log('[prisma/seed] OK');
  console.log(`  ChatbotClient        : ${clientCount}`);
  console.log(`  User                : ${userCount}`);
  console.log(`  Operator            : ${operatorCount}`);
  console.log(`  ChatbotActivity      : ${activityCount}`);
  console.log(`  ChatbotConversation  : ${conversationCount}`);
  console.log('  Test login emails    : aurora@example.com, rios@example.com');
  console.log('  Operator login       : lucia@kairikos.com (needs password reset)');
}

main()
  .catch((err) => {
    console.error('[prisma/seed] FAILED', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
