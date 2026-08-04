import { createHash, randomUUID } from 'node:crypto';
import 'server-only';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

// =============================================================================
// KAIA-4263 — Local storage shim for the onboarding session.
//
// Until the Backend Developer (KAIA-4262 owner) exposes the canonical
// `POST /api/onboarding/start` against the multi-tenant schema, the
// frontend wizard needs somewhere to persist:
//
//   * the wizard session id (idempotency key);
//   * the user's email;
//   * the selected product tier + ClientProduct id;
//   * the minimum-configuration payload;
//   * the Stripe checkout session id and activation timestamp.
//
// All five are stored on a single `OnboardingSession` row keyed by a
// public, anonymous-friendly `sessionToken`. The row lives in the same
// database as the multi-tenant schema so the canonical backend can
// later migrate the row into `Tenant` / `Profile` / `ClientProduct`
// without a second storage system.
//
// Once `POST /api/onboarding/start` lands at owner-time, this file is
// expected to delegate entirely to that endpoint and only orchestrate
// idempotency. The schema below is intentionally additive.
// =============================================================================

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface OnboardingSessionRecord {
  sessionToken: string;
  email: string;
  tenantSlug: string;
  productTier: 'starter' | 'pro' | 'premium' | null;
  productId: string | null;
  clientProductId: string | null;
  businessName: string | null;
  sector: string | null;
  whatsapp: string | null;
  contactEmail: string | null;
  stripeCheckoutSessionId: string | null;
  clientId: string | null;
  tenantId: string | null;
  status: 'pending' | 'checkout_pending' | 'active' | 'abandoned';
  activationAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface StartInput {
  email: string;
  source?: string;
  idempotencyKey?: string;
}

interface StartOutput {
  sessionToken: string;
  tenantSlug: string;
  productId: string | null;
  clientProductId: string | null;
  duplicate: boolean;
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function safeSlugFromEmail(email: string): string {
  const base = email
    .split('@')[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return (base && base.length > 1 ? base : 'cliente') + '-' + randomUUID().slice(0, 6);
}

function generateSessionToken(): string {
  return randomUUID().replace(/-/g, '');
}

export async function startOnboardingSession(input: StartInput): Promise<StartOutput> {
  if (!isDatabaseConfigured) {
    // No DB configured (preview / dev mock). Return a token + a
    // pre-baked slug so the wizard can complete locally.
    return {
      sessionToken: generateSessionToken(),
      tenantSlug: safeSlugFromEmail(input.email),
      productId: null,
      clientProductId: null,
      duplicate: false,
    };
  }

  const idem = input.idempotencyKey ?? hashEmail(input.email);
  const existing = await prisma.onboardingSession.findUnique({
    where: { idempotencyKey: idem },
    select: { sessionToken: true, tenantSlug: true, productId: true, clientProductId: true },
  });
  if (existing) {
    return {
      sessionToken: existing.sessionToken,
      tenantSlug: existing.tenantSlug,
      productId: existing.productId,
      clientProductId: existing.clientProductId,
      duplicate: true,
    };
  }

  const sessionToken = generateSessionToken();
  const tenantSlug = safeSlugFromEmail(input.email);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const row = await prisma.onboardingSession.create({
    data: {
      sessionToken,
      idempotencyKey: idem,
      email: input.email.trim().toLowerCase(),
      tenantSlug,
      status: 'pending',
      expiresAt,
      source: input.source ?? 'self_serve_landing',
    },
    select: { sessionToken: true, tenantSlug: true },
  });
  return {
    sessionToken: row.sessionToken,
    tenantSlug: row.tenantSlug,
    productId: null,
    clientProductId: null,
    duplicate: false,
  };
}

export async function getOnboardingSession(
  sessionToken: string,
): Promise<OnboardingSessionRecord | null> {
  if (!isDatabaseConfigured) return null;
  const row = await prisma.onboardingSession.findUnique({
    where: { sessionToken },
  });
  if (!row) return null;
  return {
    sessionToken: row.sessionToken,
    email: row.email,
    tenantSlug: row.tenantSlug,
    productTier: (row.productTier as OnboardingSessionRecord['productTier']) ?? null,
    productId: row.productId,
    clientProductId: row.clientProductId,
    businessName: row.businessName,
    sector: row.sector,
    whatsapp: row.whatsapp,
    contactEmail: row.contactEmail,
    stripeCheckoutSessionId: row.stripeCheckoutSessionId,
    clientId: row.clientId,
    tenantId: row.tenantId,
    status: row.status as OnboardingSessionRecord['status'],
    activationAt: row.activationAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

interface UpdateConfigInput {
  productTier?: 'starter' | 'pro' | 'premium';
  productId?: string;
  businessName?: string;
  sector?: string;
  whatsapp?: string | null;
  contactEmail?: string | null;
}

export async function updateOnboardingSession(
  sessionToken: string,
  patch: UpdateConfigInput,
): Promise<OnboardingSessionRecord | null> {
  if (!isDatabaseConfigured) return null;
  const data: Prisma.OnboardingSessionUpdateInput = {};
  if (patch.productTier !== undefined) data.productTier = patch.productTier;
  if (patch.productId !== undefined) data.productId = patch.productId;
  if (patch.businessName !== undefined) data.businessName = patch.businessName;
  if (patch.sector !== undefined) data.sector = patch.sector;
  if (patch.whatsapp !== undefined) data.whatsapp = patch.whatsapp ?? null;
  if (patch.contactEmail !== undefined) data.contactEmail = patch.contactEmail ?? null;
  const row = await prisma.onboardingSession.update({
    where: { sessionToken },
    data,
  });
  return getOnboardingSession(row.sessionToken);
}

interface MarkCheckoutInput {
  productId: string;
  productTier: 'starter' | 'pro' | 'premium';
  clientProductId: string;
  stripeCheckoutSessionId: string | null;
  businessName: string;
  sector: string;
  whatsapp?: string | null;
  contactEmail?: string | null;
  stripeCustomerId: string | null;
}

export async function markCheckoutStarted(
  sessionToken: string,
  patch: MarkCheckoutInput,
): Promise<void> {
  if (!isDatabaseConfigured) return;
  await prisma.onboardingSession.update({
    where: { sessionToken },
    data: {
      status: 'checkout_pending',
      productId: patch.productId,
      productTier: patch.productTier,
      clientProductId: patch.clientProductId,
      businessName: patch.businessName,
      sector: patch.sector,
      whatsapp: patch.whatsapp ?? null,
      contactEmail: patch.contactEmail ?? null,
      stripeCheckoutSessionId: patch.stripeCheckoutSessionId,
      stripeCustomerId: patch.stripeCustomerId,
    },
  });
}

export async function markActivated(
  sessionToken: string,
  activatedAt: Date,
): Promise<OnboardingSessionRecord | null> {
  if (!isDatabaseConfigured) return null;
  await prisma.onboardingSession.update({
    where: { sessionToken },
    data: { status: 'active', activationAt: activatedAt },
  });
  return getOnboardingSession(sessionToken);
}

export async function markAbandoned(sessionToken: string, reason: string): Promise<void> {
  if (!isDatabaseConfigured) return;
  await prisma.onboardingSession.update({
    where: { sessionToken },
    data: { status: 'abandoned', abandonedReason: reason },
  }).catch(() => undefined);
}
