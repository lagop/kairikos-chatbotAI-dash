// =============================================================================
// KAIA-14345 — shared constants for the operator onboarding advance flow.
//
// Lives in its own module so the server action file
// (`onboarding-actions.ts`) can stay strictly "use server" — Next.js 14
// forbids exporting non-function values from a `"use server"` module.
// =============================================================================

export const ALLOWED_MILESTONES = ['T+0', 'T+3', 'T+7', 'T+14'] as const;
export type AllowedMilestone = (typeof ALLOWED_MILESTONES)[number];

export function isAllowedMilestone(value: string): value is AllowedMilestone {
  return (ALLOWED_MILESTONES as readonly string[]).includes(value);
}
