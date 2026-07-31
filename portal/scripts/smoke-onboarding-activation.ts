// =============================================================================
// KAIA-8107 — onboarding activation smoke (KAIA-4263)
//
// Exercises the canonical activation function in src/lib/onboarding-activation.ts
// against the local Postgres running in the workspace. Verifies:
//
//   1. Fresh activation writes Tenant + User + Profile + ChatbotClient +
//      ChatbotClientUser + ClientProduct + flips OnboardingSession to
//      'active' atomically.
//   2. The function is idempotent: re-running with the same sessionToken
//      returns `alreadyActive: true` and writes zero new rows.
//   3. The canonical row ids (tenantId, clientId, clientProductId, userId)
//      match between the two runs.
//
// Runs against the same Postgres the app uses (DATABASE_URL from .env).
// No Stripe, no n8n, no HTTP server — pure prisma in-process.
// For local-against-empty-DB use, set SMOKE_BOOTSTRAP_SCHEMA=1 to
// auto-create the minimal canonical tables the activation function
// needs (Tenant, User, Profile, ChatbotClient, ChatbotClientUser,
// ClientProduct, Product, OnboardingSession, StripeWebhookEvent).
//
// Run:   npx tsx scripts/smoke-onboarding-activation.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import {
  activateOnboardingSession,
  getOnboardingActivationState,
} from '../src/lib/onboarding-activation';

const RUN_ID = randomUUID().slice(0, 8);
const TEST_EMAIL = `onboarding-smoke-${RUN_ID}@example.com`;
const TEST_TENANT_SLUG = `onboarding-smoke-${RUN_ID}`;
const TEST_TIER = 'starter';

function log(label: string, value: unknown) {
  console.log(`[smoke-onboarding-activation] ${label}:`, JSON.stringify(value, null, 2));
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`[smoke-onboarding-activation] FAIL: ${msg}`);
    process.exit(1);
  }
}

// The portal's Prisma migrations assume a `cuid()` SQL function that
// is not natively in Postgres. Some deploys register it; the local
// embedded Postgres does not. Bootstrap schema creation installs the
// minimum tables the activation function needs without depending on
// the historical cuid() functions.
async function bootstrapSchema(): Promise<void> {
  console.log('[smoke-onboarding-activation] bootstrapping minimal schema (SMOKE_BOOTSTRAP_SCHEMA=1)');
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Product" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "stripe_price_id" TEXT UNIQUE,
      "name" TEXT NOT NULL,
      "tier" TEXT NOT NULL UNIQUE,
      "price_cents" INTEGER NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'EUR',
      "features" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Tenant" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" TEXT NOT NULL,
      "slug" TEXT NOT NULL UNIQUE,
      "status" TEXT NOT NULL DEFAULT 'active',
      "features" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "stripe_customer_id" TEXT UNIQUE,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "User" (
      "id" TEXT PRIMARY KEY,
      "role" TEXT NOT NULL DEFAULT 'client',
      "email" TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT,
      "passwordSetAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Profile" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL UNIQUE,
      "tenant_id" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE RESTRICT,
      "role" TEXT NOT NULL DEFAULT 'viewer',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ChatbotClient" (
      "id" TEXT PRIMARY KEY,
      "email" TEXT NOT NULL UNIQUE,
      "name" TEXT NOT NULL,
      "companyName" TEXT,
      "tier" TEXT NOT NULL DEFAULT 'starter',
      "stripeCustomerId" TEXT,
      "state" TEXT NOT NULL DEFAULT 'in-progress',
      "goLiveAt" TIMESTAMP(3),
      "supabaseClientId" TEXT UNIQUE,
      "tenant_id" UUID REFERENCES "Tenant"("id") ON DELETE SET NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ChatbotClientUser" (
      "id" TEXT PRIMARY KEY,
      "clientId" TEXT NOT NULL REFERENCES "ChatbotClient"("id") ON DELETE CASCADE,
      "nextAuthEmail" TEXT NOT NULL UNIQUE,
      "userId" TEXT UNIQUE,
      "tenant_id" UUID REFERENCES "Tenant"("id") ON DELETE SET NULL
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ClientProduct" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "client_id" TEXT NOT NULL REFERENCES "ChatbotClient"("id") ON DELETE CASCADE,
      "product_id" UUID NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT,
      "tenant_id" UUID REFERENCES "Tenant"("id") ON DELETE SET NULL,
      "status" TEXT NOT NULL DEFAULT 'active',
      "subscribed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "cancelled_at" TIMESTAMP(3),
      "created_by" TEXT,
      "changed_by" TEXT,
      "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ClientProduct_client_id_product_id_key" UNIQUE ("client_id", "product_id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OnboardingSession" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "session_token" TEXT NOT NULL UNIQUE,
      "idempotency_key" TEXT NOT NULL UNIQUE,
      "email" TEXT NOT NULL,
      "tenant_slug" TEXT NOT NULL UNIQUE,
      "product_tier" TEXT,
      "product_id" UUID,
      "client_product_id" UUID,
      "business_name" TEXT,
      "sector" TEXT,
      "whatsapp" TEXT,
      "contact_email" TEXT,
      "stripe_checkout_session_id" TEXT,
      "stripe_customer_id" TEXT,
      "client_id" TEXT,
      "tenant_id" UUID,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "activation_at" TIMESTAMP(3),
      "abandoned_reason" TEXT,
      "source" TEXT NOT NULL DEFAULT 'self_serve_landing',
      "expires_at" TIMESTAMP(3) NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StripeWebhookEvent" (
      "id" TEXT PRIMARY KEY,
      "eventId" TEXT NOT NULL UNIQUE,
      "eventType" TEXT NOT NULL,
      "payloadHash" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "stripeApiVersion" TEXT,
      "processedAt" TIMESTAMP(3),
      "appliedTo" TEXT,
      "errorMessage" TEXT,
      "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // cuid() shim for tables that reference it. The activation function
  // inserts User and Profile with cuid-shaped ids via the @default(cuid())
  // Prisma directive; we approximate by using random text ids.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION cuid() RETURNS text AS $$
    SELECT 'c' || substr(md5(random()::text), 1, 24);
    $$ LANGUAGE sql VOLATILE;
  `);
}

async function ensureProduct(tier: string): Promise<{ id: string; tier: string }> {
  const existing = await prisma.product.findUnique({ where: { tier } });
  if (existing) return { id: existing.id, tier: existing.tier };
  const created = await prisma.product.create({
    data: {
      name: `Smoke ${tier}`,
      tier,
      priceCents: 9900,
      currency: 'EUR',
      isActive: true,
    },
  });
  return { id: created.id, tier: created.tier };
}

async function main() {
  console.log(`[smoke-onboarding-activation] starting (run=${RUN_ID})`);
  if (process.env.SMOKE_BOOTSTRAP_SCHEMA === '1') {
    await bootstrapSchema();
  }
  const product = await ensureProduct(TEST_TIER);
  log('product', product);

  // Build an OnboardingSession row that mirrors what the wizard writes
  // before the Stripe webhook fires.
  const sessionToken = randomUUID().replace(/-/g, '');
  const idempotencyKey = createHash('sha256').update(TEST_EMAIL).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.onboardingSession.create({
    data: {
      sessionToken,
      idempotencyKey,
      email: TEST_EMAIL,
      tenantSlug: TEST_TENANT_SLUG,
      productTier: product.tier,
      productId: product.id,
      status: 'checkout_pending',
      source: 'smoke',
      expiresAt,
    },
  });

  try {
    // ---- 1. First activation ----
    const first = await activateOnboardingSession({
      sessionToken,
      stripeCustomerId: `cus_smoke_${RUN_ID}`,
    });
    log('first activation', first);

    assert(first.activated === true, 'first.activated should be true');
    assert(first.alreadyActive === false, 'first.alreadyActive should be false');
    assert(typeof first.tenantId === 'string', 'tenantId should be a uuid string');
    assert(typeof first.clientId === 'string', 'clientId should be a string');
    assert(typeof first.userId === 'string', 'userId should be a string');
    assert(typeof first.clientProductId === 'string', 'clientProductId should be a uuid string');

    // ---- 2. Verify canonical rows ----
    const tenant = await prisma.tenant.findUnique({ where: { id: first.tenantId } });
    assert(tenant, 'tenant should exist');
    assert(tenant!.slug === TEST_TENANT_SLUG, `tenant.slug mismatch: ${tenant!.slug}`);
    assert(tenant!.stripeCustomerId === `cus_smoke_${RUN_ID}`, 'tenant.stripeCustomerId should be set');

    const user = await prisma.user.findUnique({ where: { id: first.userId } });
    assert(user, 'user should exist');
    assert(user!.email === TEST_EMAIL, `user.email mismatch: ${user!.email}`);

    const profile = await prisma.profile.findUnique({ where: { userId: first.userId } });
    assert(profile, 'profile should exist');
    assert(profile!.tenantId === first.tenantId, 'profile.tenantId should match');

    const client = await prisma.chatbotClient.findUnique({ where: { id: first.clientId } });
    assert(client, 'chatbotClient should exist');
    assert(client!.state === 'live', `chatbotClient.state should be live, got ${client!.state}`);
    assert(client!.tenantId === first.tenantId, 'chatbotClient.tenantId should match');

    const clientUser = await prisma.chatbotClientUser.findUnique({
      where: { nextAuthEmail: TEST_EMAIL },
    });
    assert(clientUser, 'chatbotClientUser should exist');
    assert(clientUser!.clientId === first.clientId, 'chatbotClientUser.clientId should match');
    assert(clientUser!.userId === first.userId, 'chatbotClientUser.userId should match');

    const clientProduct = await prisma.clientProduct.findUnique({
      where: { id: first.clientProductId },
    });
    assert(clientProduct, 'clientProduct should exist');
    assert(clientProduct!.status === 'active', `clientProduct.status should be active, got ${clientProduct!.status}`);
    assert(clientProduct!.tenantId === first.tenantId, 'clientProduct.tenantId should match');

    const session = await prisma.onboardingSession.findUnique({ where: { sessionToken } });
    assert(session, 'session should still exist');
    assert(session!.status === 'active', `session.status should be active, got ${session!.status}`);
    assert(session!.tenantId === first.tenantId, 'session.tenantId should be backfilled');
    assert(session!.clientId === first.clientId, 'session.clientId should be backfilled');
    assert(session!.clientProductId === first.clientProductId, 'session.clientProductId should be backfilled');

    // ---- 3. Idempotency: second activation is a no-op ----
    const second = await activateOnboardingSession({
      sessionToken,
      stripeCustomerId: `cus_smoke_${RUN_ID}`,
    });
    log('second activation', second);

    assert(second.activated === true, 'second.activated should be true');
    assert(second.alreadyActive === true, 'second.alreadyActive should be true');
    assert(second.tenantId === first.tenantId, 'tenantId should be stable');
    assert(second.clientId === first.clientId, 'clientId should be stable');
    assert(second.clientProductId === first.clientProductId, 'clientProductId should be stable');
    assert(second.activationAt.getTime() === first.activationAt.getTime(), 'activationAt should be stable');

    // ---- 4. getOnboardingActivationState reflects canonical state ----
    const state = await getOnboardingActivationState(sessionToken);
    log('canonical state', state);
    assert(state, 'state should resolve');
    assert(state!.status === 'active', `state.status should be active, got ${state!.status}`);
    assert(state!.tenantId === first.tenantId, 'state.tenantId should match');
    assert(state!.clientId === first.clientId, 'state.clientId should match');
    assert(state!.clientProductId === first.clientProductId, 'state.clientProductId should match');
    assert(state!.userId === first.userId, 'state.userId should match');

    console.log('[smoke-onboarding-activation] OK');
    console.log('---EVIDENCE---');
    console.log('tenantId=' + first.tenantId);
    console.log('clientId=' + first.clientId);
    console.log('userId=' + first.userId);
    console.log('clientProductId=' + first.clientProductId);
    console.log('activationAt=' + first.activationAt.toISOString());
    console.log('---END---');
  } finally {
    if (process.env.SMOKE_KEEP_ROWS === '1') {
      console.log('[smoke-onboarding-activation] SMOKE_KEEP_ROWS=1 — leaving rows in place for inspection');
      await prisma.$disconnect();
      return;
    }
    // Cleanup — remove the smoke rows so the test is re-runnable.
    await prisma.clientProduct.deleteMany({
      where: { client: { email: TEST_EMAIL } },
    });
    await prisma.chatbotClientUser.deleteMany({
      where: { nextAuthEmail: TEST_EMAIL },
    });
    await prisma.chatbotClient.deleteMany({
      where: { email: TEST_EMAIL },
    });
    await prisma.profile.deleteMany({
      where: { user: { email: TEST_EMAIL } },
    });
    await prisma.user.deleteMany({
      where: { email: TEST_EMAIL },
    });
    await prisma.tenant.deleteMany({
      where: { slug: TEST_TENANT_SLUG },
    });
    await prisma.onboardingSession.deleteMany({
      where: { sessionToken },
    });
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[smoke-onboarding-activation] FATAL:', err);
  process.exit(1);
});
