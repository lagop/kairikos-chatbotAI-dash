// =============================================================================
// WP-15 — shared types for the multi-product wizard catalog registry.
//
// Moved out of wizard-catalog.ts (now a deprecated re-export shim, see that
// file) so a product catalog module (chatbot.ts today; web.ts etc. later)
// can depend on them without importing the shim itself.
// =============================================================================

export type WizardTier = 'starter' | 'pro' | 'premium';
export type WizardBlock = 'identidad' | 'comportamiento' | 'activacion';
export type WizardStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface WizardStepDefinition {
  /** Step number as it appears in the spec (1..12). The URL stepKey uses
   *  the same value, encoded as a string. */
  readonly number: WizardStepNumber;
  /** URL-safe string identifier. Matches the stepKey column on
   *  ChatbotConfigStep. Currently the number itself, kept as a string for
   *  forward compat (a future renaming would only touch the URL, not the
   *  data column). */
  readonly key: string;
  /** Human-readable label (Spanish; spec commit). */
  readonly label: string;
  /** High-level block the step belongs to (drives the 3-block progress bar). */
  readonly block: WizardBlock;
  /** Whether the step is required for the cliente to reach `ready`. Drives
   *  the `config_complete` trigger. */
  readonly requiredForReady: boolean;
  /** Whether the step is deferred to v1.1 (Step 12). When true, the cliente
   *  view hides it for every tier and the operator view renders the
   *  "Próximamente" label. */
  readonly v11Deferred: boolean;
  /** Tier visibility predicate. Step 12 returns `() => false` for every
   *  tier. Steps 3 and 7 return false only for `starter`. */
  readonly visibleFor: (tier: WizardTier | null) => boolean;
  /** Server-side default payload applied when the step is hidden for the
   *  cliente's tier (or when the operator has not yet captured any data
   *  and the bot is being constructed cold-start). The shape mirrors what
   *  the cliente would have entered. */
  readonly defaultPayload: Record<string, unknown>;
}
