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

// WP-07 — moved out of page.tsx so both it and the extracted _client.tsx
// controls component can use them without duplicating the maps.
export const MILESTONE_LABEL: Record<string, string> = {
  'T+0': 'Bienvenida y acceso al portal',
  'T+3': 'Configuración inicial',
  'T+7': 'Puesta en producción',
  'T+14': 'Revisión y optimización',
};

export const MILESTONE_TO_DB: Record<string, 't_plus_0' | 't_plus_3' | 't_plus_7' | 't_plus_14'> = {
  'T+0': 't_plus_0',
  'T+3': 't_plus_3',
  'T+7': 't_plus_7',
  'T+14': 't_plus_14',
};
