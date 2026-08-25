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
// Real argon2id hash of 'devpassword123', generated via
// @node-rs/argon2 with this codebase's own default params (see
// hashPassword() in src/lib/operator-crypto.ts) — the previous value
// here was a hand-written placeholder that LOOKED like a valid argon2
// hash but never actually verified against 'devpassword123' (caught by
// actually trying to log in against a real Postgres; every login
// attempt against a seeded client had been silently impossible until
// now, since no environment had a reachable database to catch it).
const DEV_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$hd0vm1Nk/ZoaOQ/0r148Vg$w78pK34dgpYwbtiUv0eqHJvHMHKfwxfNJQAg6vXCEh0';

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
// `reviews` (Google reviews) was gated `isActive: false` while WP-20 (the
// Google API access approval) was pending; now active with its two
// self-serve tiers (Basic/Pro — see the entry below for the source and
// the documented feature gap against the marketing page). Every
// `stripeRecurringPriceId`/`stripeSetupPriceId` in this file is a
// PLACEHOLDER — no real Stripe Price objects exist yet. Self-serve
// checkout (api/portal/billing/checkout) 404s with
// `product_price_id_missing` until they're swapped for real Price ids
// created in the Stripe Dashboard; do not announce reviews to clients
// before that swap.
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
  // Free-form per-tier feature data (schema.prisma's Product.features —
  // present since WP-12 but never populated until now). First real use:
  // { channels: string[] } — which chatbot channels (WP: conexión de
  // canales) a tier unlocks, read by getAllowedChannelsForClient() in
  // src/lib/channel-access.ts. Reference mapping, not definitive —
  // adjusting it later is a seed change, not a code change.
  features?: Record<string, unknown>;
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
    features: { channels: ['web'] },
  },
  {
    code: 'chatbot', tier: 'pro', name: 'Chatbot IA — Pro',
    priceCents: 24900, setupFeeCents: 39900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_pro', stripeSetupPriceId: null,
    features: { channels: ['web', 'telegram', 'whatsapp'] },
  },
  {
    code: 'chatbot', tier: 'premium', name: 'Chatbot IA — Premium',
    priceCents: 49900, setupFeeCents: 39900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_premium', stripeSetupPriceId: null,
    features: { channels: ['web', 'telegram', 'whatsapp', 'messenger', 'instagram'] },
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
  // Google reviews — two self-serve tiers, matching the real published
  // pricing at kairikos.com/resenas-google (checked 2026-08-15). WP-15 —
  // code renamed from 'resenas' to 'reviews', same reason as 'leads'
  // above. stripeRecurringPriceId/stripeSetupPriceId are PLACEHOLDERS
  // pending real Stripe Price objects — see the catalog-level comment
  // above before reseeding prod.
  //
  // A third plan, "Enterprise", is custom-priced ("a medida") and
  // explicitly not self-serve on the marketing page — it has no fixed
  // amount to charge via Stripe Checkout, so it's deliberately NOT
  // modeled as a Product row here. /portal/productos instead shows a
  // "contáctanos" note under the Reseñas card pointing to support.
  //
  // The marketing page also promises real functionality this portal
  // does not build yet — documented here so the gap stays visible
  // rather than silently forgotten:
  //   - multichannel requests (email + SMS + WhatsApp) — only email
  //     (Resend) exists today (WP-22b)
  //   - auto-triggering requests from the client's own booking/CRM
  //     software (Doctoralia, TheFork, Bizneo, Holded, etc. — 20+
  //     integrations advertised) — campaigns are 100% manual today,
  //     the operator pastes a recipient list
  //   - an internal pre-review satisfaction survey (Pro plan only,
  //     explicitly does not gate the actual Google review request)
  //   - client-facing data export
  //   - tracking/enforcement of the "double your reviews in 90 days or
  //     we refund the last month" guarantee
  {
    code: 'reviews', tier: 'basic', name: 'Reseñas en Google — Basic',
    priceCents: 9900, setupFeeCents: 9900, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_reviews_basic', stripeSetupPriceId: 'price_reviews_basic_setup',
  },
  {
    code: 'reviews', tier: 'pro', name: 'Reseñas en Google — Pro',
    priceCents: 14900, setupFeeCents: 0, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_reviews_pro', stripeSetupPriceId: null,
  },
  // WP-XX — Missed-call recovery + review requests. Three tiers priced by
  // BUSINESS SIZE, not by included minutes: metering minutes is what every
  // Spanish competitor does (Recepcionista.com 500/750/1.500 min,
  // IONOS 0,49 €/llamada extra) and the resulting variable bill is exactly
  // the anxiety this product sells against. Flat rate is affordable here
  // because "Modo Recado" takes a 30-60s message rather than holding a
  // conversation — ~25-30 min/month/client, an order of magnitude under
  // those packages. That stops being true if "Modo Recepción" (full
  // conversational AI) ever ships; revisit the flat rate then.
  //
  // Bundling the review half is the deliberate differentiator: no Spanish
  // AI-receptionist competitor offers reputation at all. The separate
  // 'reviews' product above stays for a different segment (email channel,
  // panel-driven, no telephony) — see /portal/productos.
  //
  // WP-XX (2026-08-25) — isActive: true. The user made the call
  // explicitly, twice, aware Coexistence (Fase 8) is not yet verified
  // against a real Meta app: this is a deliberate decision to sell ahead
  // of that proof, not an oversight. Do not revert this to false without
  // asking first.
  //
  // stripeRecurringPriceId/stripeSetupPriceId below are still
  // PLACEHOLDERS. Do not deploy or re-seed this into an environment
  // until an operator has run Bootstrap for these three tiers at
  // /admin/portal/settings/billing — otherwise Contratar will 502 for a
  // real paying client. Bootstrap writes the real ids straight onto the
  // Product row; running this seed again afterwards would only
  // overwrite isActive/name/price fields (see the upsert below), not the
  // Stripe ids, which the create-only branch never touches on update.
  {
    code: 'recall', tier: 'solo', name: 'Recuperación de llamadas — Autónomo',
    priceCents: 14900, setupFeeCents: 29000, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_recall_solo', stripeSetupPriceId: 'price_recall_solo_setup',
  },
  {
    code: 'recall', tier: 'team', name: 'Recuperación de llamadas — Equipo',
    priceCents: 24900, setupFeeCents: 39000, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_recall_team', stripeSetupPriceId: 'price_recall_team_setup',
  },
  {
    code: 'recall', tier: 'business', name: 'Recuperación de llamadas — Empresa',
    priceCents: 39900, setupFeeCents: 49000, currency: 'EUR', isActive: true,
    stripeRecurringPriceId: 'price_recall_business', stripeSetupPriceId: 'price_recall_business_setup',
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
        features: p.features ?? {},
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
        features: p.features ?? {},
      },
    });
  }

  // A renamed tier (e.g. reviews' 'standard' → 'basic'/'pro', this WP)
  // upserts the new rows but never touches the old one — it just
  // lingers, isActive:true, still showing up in every `where: {isActive:
  // true}` query (e.g. /portal/productos), a stale price alongside the
  // real ones. Deactivate (not delete — a real ClientProduct could FK
  // to it) any row whose (code, tier) fell out of the catalog above, so
  // reseeding an existing database actually reconciles to the current
  // source of truth instead of only ever adding to it.
  const currentPairs = new Set(PRODUCT_CATALOG.map((p) => `${p.code}:${p.tier}`));
  const existing = await prisma.product.findMany({ where: { isActive: true }, select: { id: true, code: true, tier: true } });
  const staleIds = existing.filter((p) => !currentPairs.has(`${p.code}:${p.tier}`)).map((p) => p.id);
  if (staleIds.length > 0) {
    await prisma.product.updateMany({ where: { id: { in: staleIds } }, data: { isActive: false } });
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
    // Keep passwordHash in sync with DEV_PASSWORD_HASH on every reseed —
    // an empty `update` here previously meant an already-existing row
    // kept serving whatever hash it was FIRST created with forever,
    // even after DEV_PASSWORD_HASH changed (caught when the constant
    // was fixed from a fake hash to a real one and reseeding an
    // existing DB silently kept the old, non-working value).
    update: { passwordHash: DEV_PASSWORD_HASH },
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
    update: { passwordHash: DEV_PASSWORD_HASH },
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
