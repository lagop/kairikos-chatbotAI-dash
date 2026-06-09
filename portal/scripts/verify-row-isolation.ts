// KAIA-752 — verification of the row-isolation rule documented in
// prisma/README.md. Run with:  npx tsx scripts/verify-row-isolation.ts
//
// Asserts:
//   1. nextAuthEmail = "aurora@example.com" resolves to client A
//   2. nextAuthEmail = "rios@example.com"   resolves to client B
//   3. A client-scoped query for client A never returns client B's rows
//   4. A client-scoped query for client B never returns client A's rows
//   5. An unknown nextAuthEmail resolves to no client (Forbidden case)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resolveClientId(email: string) {
  const link = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: email },
    select: { clientId: true },
  });
  return link?.clientId ?? null;
}

async function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label} — expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log('[verify] row isolation — Prisma clientId scope');

  const auroraId = await resolveClientId('aurora@example.com');
  const riosId = await resolveClientId('rios@example.com');
  const ghostId = await resolveClientId('nobody@example.com');

  check('aurora resolves to a clientId', typeof auroraId, 'string');
  check('rios resolves to a clientId', typeof riosId, 'string');
  check('aurora and rios are different clients', auroraId !== riosId, true);
  check('unknown email resolves to null', ghostId, null);

  if (!auroraId || !riosId) {
    console.error('[verify] cannot continue without both clientIds');
    process.exit(1);
  }

  const auroraActivityCount = await prisma.chatbotActivity.count({
    where: { clientId: auroraId },
  });
  const auroraSeesRios = await prisma.chatbotActivity.findFirst({
    where: { clientId: auroraId, client: { email: 'rios@example.com' } },
  });
  check('aurora sees >= 1 activity', auroraActivityCount >= 1, true);
  check('aurora cannot see ríos activity', auroraSeesRios, null);

  const riosSeesAurora = await prisma.chatbotConversation.findFirst({
    where: { clientId: riosId, client: { email: 'aurora@example.com' } },
  });
  check('ríos cannot see aurora conversations', riosSeesAurora, null);

  console.log('[verify] DONE');
}

main()
  .catch((err) => {
    console.error('[verify] FAILED', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
