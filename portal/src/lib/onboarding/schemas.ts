import { z } from 'zod';

// =============================================================================
// KAIA-4263 — Shared schemas for the public self-serve onboarding wizard.
//
// All three endpoints (`/api/onboarding/start`,
// `/api/onboarding/config`, `/api/public/billing/checkout-session`) use
// the schemas in this file so frontend, backend, and Stripe metadata
// agree on the wire shape.
//
// The body of each schema mirrors exactly what the React components
// emit. Keep them in sync with `lib/onboarding/self-serve-context.tsx`.
// =============================================================================

export const SignupSchema = z.object({
  email: z.string().email().max(254),
  source: z.string().min(1).max(64).default('self_serve_landing'),
  // Optional: a client-provided idempotency key. If absent, the server
  // mints a UUIDv4 fallback. Stored so retries never create two tenants.
  idempotencyKey: z.string().min(8).max(128).optional(),
});
export type SignupPayload = z.infer<typeof SignupSchema>;

export const ConfigSchema = z.object({
  sessionId: z.string().min(8).max(64),
  businessName: z.string().min(2).max(120),
  sector: z.string().min(2).max(40),
  whatsapp: z.string().max(40).optional(),
  contactEmail: z.string().email().max(254).optional(),
});
export type ConfigPayload = z.infer<typeof ConfigSchema>;

export const CheckoutRequestSchema = z.object({
  sessionId: z.string().min(8).max(64),
  productTier: z.enum(['starter', 'pro', 'premium']),
  email: z.string().email(),
  config: z.object({
    businessName: z.string().min(2).max(120),
    sector: z.string().min(2).max(40),
    whatsapp: z.string().max(40).optional(),
    contactEmail: z.string().email().optional(),
  }),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const ActivateSchema = z.object({
  sessionId: z.string().min(8).max(64),
  clientProductId: z.string().min(8).max(64).optional(),
  stripeSessionId: z.string().min(8).max(128).optional(),
});
export type ActivatePayload = z.infer<typeof ActivateSchema>;
