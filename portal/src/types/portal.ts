export type ChatbotTier = 'starter' | 'pro' | 'premium';

// WP-23 — this used to be a 5-value UI vocabulary (`in_progress`, underscore)
// that only partially overlapped with what ChatbotClient.state actually
// writes (schema.prisma's `state` column comment; `pending` and `updating`
// there are hyphen/underscore look-alikes that never matched, and
// `go-live-pending` / `ready` / `updating` had no UI value at all —
// toOnboardingStatus() silently collapsed all three to `in_progress`).
//
// Convention decision: hyphen, matching what's already stored in the
// `state` column and already used by the admin PATCH route's
// ALLOWED_STATES (src/app/api/admin/portal/clients/[id]/route.ts). This
// needs zero data migration — only the read-side TypeScript type and its
// few `in_progress`-literal producers move to match the DB, not the other
// way around.
// WP-14 — 'archived' and 'draft' were already writable via POST
// /api/internal/clients/[id]/state-transition's ALLOWED_STATES (KAIA-3127,
// Paperclip's Day-2 endpoint) but missing from this union, so
// toOnboardingStatus() in portal-data.ts silently collapsed both to
// 'in-progress' with a console.error anomaly log — a real, live bug this
// WP fixes by making the type match the actual writable set.
export type OnboardingStatus =
  | 'pending'
  | 'in-progress'
  | 'go-live-pending'
  | 'ready'
  | 'live'
  | 'updating'
  | 'paused'
  | 'cancelled'
  | 'archived'
  | 'draft';

export type UserRole = 'owner' | 'admin' | 'viewer';

export interface ChatbotClient {
  id: string;
  slug: string;
  companyName: string;
  primaryContactEmail: string;
  stripeCustomerId: string | null;
  tier: ChatbotTier;
  onboardingStatus: OnboardingStatus;
  createdAt: string;
  goLiveDate: string | null;
  chatbotSpaceId: string | null;
}

export interface ChatbotClientUser {
  id: string;
  email: string;
  role: UserRole;
  clientId: string;
}

export type OnboardingStepId = 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14';

export interface OnboardingTimelineRow {
  id: string;
  step: OnboardingStepId;
  label: string;
  description: string;
  occurredAt: string | null;
  status: 'done' | 'current' | 'pending';
}

export interface ChatbotStatusSummary {
  spaceId: string;
  status: OnboardingStatus;
  goLiveDate: string | null;
  last7Days: {
    conversations: number;
    fallbackRate: number;
    escalationRate: number;
  };
}

export interface ConversationSummary {
  id: string;
  startedAt: string;
  durationSeconds: number;
  outcome: 'resolved' | 'escalated' | 'abandoned';
  channel: 'whatsapp' | 'web' | 'instagram' | 'other';
}

export interface ConversationTranscript {
  id: string;
  startedAt: string;
  endedAt: string;
  outcome: ConversationSummary['outcome'];
  channel: ConversationSummary['channel'];
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    at: string;
  }>;
}

export interface BillingSummary {
  tier: ChatbotTier;
  tierLabel: string;
  monthlyFeeCents: number;
  currency: 'EUR';
  nextInvoiceDate: string | null;
  nextInvoiceAmountCents: number | null;
  stripeCustomerPortalUrl: string | null;
  stripeCustomerId: string | null;
}

export interface SupportLink {
  label: string;
  href: string;
  description: string;
}

export interface PortalContext {
  client: ChatbotClient;
  onboarding: OnboardingTimelineRow[];
  chatbot: ChatbotStatusSummary;
}

// KAIA-3921 — client profile contract. Mirrors the fields exposed by
// `GET /api/portal/me` so the profile page can render the same shape
// the API returns. The PATCH endpoint accepts the same fields minus the
// server-managed ones (id, slug, createdAt, goLiveDate, etc.).
export interface ClientProfile extends ChatbotClient {
  contactName: string | null;
}

// Subset of ClientProfile the client UI is allowed to edit. The
// backend owns audit, validation depth, and side effects — the
// frontend only renders inputs and surfaces errors.
export interface ClientProfileUpdate {
  contactName?: string;
  primaryContactEmail?: string;
}

export const PROFILE_EDITABLE_FIELDS = ['contactName', 'primaryContactEmail'] as const;
export type ProfileEditableField = (typeof PROFILE_EDITABLE_FIELDS)[number];
