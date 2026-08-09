/**
 * Set or reset a ChatbotClientUser password (KAIA-2103).
 *
 * Usage:
 *   EMAIL=client@example.com PASSWORD=newpass npx tsx scripts/set-client-password.ts
 */

import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.EMAIL?.toLowerCase().trim();
  const password = process.env.PASSWORD;

  if (!email || !password) {
    console.error('Usage: EMAIL=... PASSWORD=... npx tsx scripts/set-client-password.ts');
    process.exit(1);
  }

  const record = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: email },
    select: { id: true },
  });
  if (!record) {
    console.error(`No ChatbotClientUser found for email: ${email}`);
    process.exit(1);
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.chatbotClientUser.update({
    where: { id: record.id },
    data: { passwordHash: hash },
  });

  console.log(`Password updated for ${email}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
