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
