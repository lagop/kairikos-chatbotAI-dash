export type ChatbotTier = 'starter' | 'pro' | 'premium';

export type OnboardingStatus = 'pending' | 'in_progress' | 'live' | 'paused' | 'cancelled';

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
