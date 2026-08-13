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
// WP-12: also upserts the real Product catalog (PRODUCT_CATALOG below) —
// this is now the source of truth for the five Kairikos products, not the
// old multi_tenant_phase0 migration's raw INSERT (which only ever knew
// about the three chatbot tiers).
//
// Run with:  npx prisma db seed
// Idempotent: re-running upserts the same rows by their unique keys
// (ChatbotClient.email, ChatbotClientUser.nextAuthEmail, User.email,
// Product.(code, tier)) and skips activities / conversations if a
// matching pair already exists.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';

const prisma = new PrismaClient();

// Dev-only password hash for seed users. DO NOT use in production.
// Hash of 'devpassword123' using argon2id.
const DEV_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$QU5FRC5BTi80SjZSdVBFQQ$CfJqKkKj7mJ9xLs1pVnI8hKmN3oR4tW6yB2cD4eF0g';

// =============================================================================
// WP-12 — the real Kairikos product catalog (kairikos.com, checked 2026-08-14).
//
// `priceCents` is the monthly fee, `setupFeeCents` the one-time onboarding
// fee — billing type derives from the two (see the Product model comment
// in schema.prisma). Exported so it can be asserted against directly in a
// unit test without spinning up Prisma.
//
// Two products only publish a price RANGE on the site, not a fixed
// number (chatbot setup: €299–€499; web platform: €799–€1.299) — this
// catalog uses the low end of each range ("desde X€"), noted per entry.
// `resenas` (Google reviews) publishes no pricing at all yet — it's
// seeded `isActive: false` (not sellable) with a placeholder price,
// pending the Google API approval tracked as a Sprint-0 risk (WP-20).
// =============================================================================
export interface ProductCatalogEntry {
  code: string;
  tier: string;
  name: string;
  priceCents: number;
  setupFeeCents: number;
  currency: string;
  isActive: boolean;
  stripeRecurringPriceId: string | null;
  stripeSetupPriceId: string | null;
}

export const PRODUCT_CATALOG: ProductCatalogEntry[] = [
  // Chatbot — three tiers, unchanged monthly prices, now with the setup
  // fee kairikos.com actually charges (previously unmodeled: Product had
  // no setupFeeCents column before WP-12). €299–€499 range → using €399
  // as the single per-tier figure until Sales confirms a per-tier split.
  {
    code: 'chatbot', tier: 'starter', name: 'Chatbot IA — Starter',
    priceCents: 9900, setupFeeCents: 39900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_starter', stripeSetupPriceId: null,
  },
  {
    code: 'chatbot', tier: 'pro', name: 'Chatbot IA — Pro',
    priceCents: 24900, setupFeeCents: 39900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_pro', stripeSetupPriceId: null,
  },
  {
    code: 'chatbot', tier: 'premium', name: 'Chatbot IA — Premium',
    priceCents: 49900, setupFeeCents: 39900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_premium', stripeSetupPriceId: null,
  },
  // Web platform — one-time only, no subscription. €799–€1.299 range →
  // using the €799 floor ("desde 799€").
  {
    code: 'web', tier: 'standard', name: 'Plataforma web profesional',
    priceCents: 0, setupFeeCents: 79900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: null, stripeSetupPriceId: null,
  },
  // AI lead capture — setup fee + monthly, both fixed on the site.
  // WP-15 — code renamed from 'captacion' to 'leads' to match the
  // ProductCode union src/lib/catalogs/index.ts introduces. Nothing else
  // referenced 'captacion' as a string literal (grepped before renaming;
  // Product.code is a free-form DB column, not FK-constrained), so this
  // is a same-PR rename, not a migration.
  {
    code: 'leads', tier: 'standard', name: 'Sistema IA de captación',
    priceCents: 14900, setupFeeCents: 49900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: null, stripeSetupPriceId: null,
  },
  // SEO — monthly only, no setup fee.
  {
    code: 'seo', tier: 'standard', name: 'SEO y contenido con IA',
    priceCents: 19900, setupFeeCents: 0, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: null, stripeSetupPriceId: null,
  },
  // Google reviews — not sellable yet, no published price. See WP-20 /
  // the Sprint 0 risk register: blocked on Google API approval.
  // WP-15 — code renamed from 'resenas' to 'reviews', same reason as
  // 'leads' above.
  {
    code: 'reviews', tier: 'standard', name: 'Reseñas en Google',
    priceCents: 0, setupFeeCents: 0, currency: 'EUR', isActive: false,
    stripeRecurringPriceId: null, stripeSetupPriceId: null,
  },
];

async function seedProductCatalog(): Promise<void> {
  for (const p of PRODUCT_CATALOG) {
    await prisma.product.upsert({
      where: { code_tier: { code: p.code, tier: p.tier } },
      update: {
        name: p.name,
        priceCents: p.priceCents,
        setupFeeCents: p.setupFeeCents,
        currency: p.currency,
        isActive: p.isActive,
      },
      create: {
        code: p.code,
        tier: p.tier,
        name: p.name,
        priceCents: p.priceCents,
        setupFeeCents: p.setupFeeCents,
        currency: p.currency,
        isActive: p.isActive,
        stripeRecurringPriceId: p.stripeRecurringPriceId,
        stripeSetupPriceId: p.stripeSetupPriceId,
      },
    });
  }
}

async function main() {
  await seedProductCatalog();

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
  const [clientCount, userCount, operatorCount, activityCount, conversationCount, productCount] = await Promise.all([
    prisma.chatbotClient.count(),
    prisma.user.count(),
    prisma.operator.count(),
    prisma.chatbotActivity.count(),
    prisma.chatbotConversation.count(),
    prisma.product.count(),
  ]);

  console.log('[prisma/seed] OK');
  console.log(`  ChatbotClient        : ${clientCount}`);
  console.log(`  User                : ${userCount}`);
  console.log(`  Operator            : ${operatorCount}`);
  console.log(`  ChatbotActivity      : ${activityCount}`);
  console.log(`  ChatbotConversation  : ${conversationCount}`);
  console.log(`  Product              : ${productCount}`);
  console.log('  Test login emails    : aurora@example.com, rios@example.com');
  console.log('  Operator login       : lucia@kairikos.com (needs password reset)');
}

// Only run when executed directly (`npx prisma db seed` / `tsx prisma/seed.ts`),
// not when a test imports PRODUCT_CATALOG or seedProductCatalog from this
// module — those must be importable without side-effecting a real database.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((err) => {
      console.error('[prisma/seed] FAILED', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
