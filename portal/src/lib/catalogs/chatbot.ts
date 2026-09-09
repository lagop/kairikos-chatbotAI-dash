// =============================================================================
// KAIA-1166 (BE-4) — Wizard step catalog for the 'chatbot' product (v1).
//
// Moved here verbatim from wizard-catalog.ts by WP-15 — the values are
// byte-for-byte identical to the pre-WP-15 WIZARD_STEP_CATALOG (see
// tests/unit/product-catalog-registry.test.ts's snapshot test). See that
// file's git history for the original KAIA-1166 rationale.
//
// One row per v1 step (1..12). Steps 1-10 + 11 (Pruebas) ship in v1.
// Step 12 (Integraciones) is deferred to v1.1 (KAIA-1108) and is **not
// constructed** in v1: it exists in the catalog so the operator view can
// render the "Próximamente" label and the cliente view can hide it
// uniformly across all tiers.
//
// Tier visibility rule (per `spec-wizard-chatbot.md` v0.2 §"Visibilidad por
// tier", addenda CEO #1):
//
//   • Starter: Step 3 (Servicios y tarifas) and Step 7 (Derivación) hidden,
//     the server returns the catalog `defaultPayload` instead.
//   • Pro / Premium: see every step except Step 12.
//   • Step 12: hidden in cliente view for every tier in v1 (deferred to
//     v1.1 regardless of tier — see KAIA-1108 + the umbrella v1.1).
//   • Operator view: ignores tier. Always renders 11 + the 12 label
//     (visible: true, editable: false for Step 12).
//
// This file is a pure module (no I/O, no Prisma). Frozen with Object.freeze
// so callers can rely on the catalog being immutable at runtime.
// =============================================================================

import type { WizardStepDefinition, WizardTier, WizardStepNumber } from './types';

// ---------------------------------------------------------------------------
// Per-tier visibility predicates
//
// `visibleFor(tier)` returns true when the step is visible to a cliente
// on that tier. null tier is treated as "starter" (the DB default) so
// the safety rails kick in by default.
// ---------------------------------------------------------------------------

const visibleForAllTiers = (_tier: WizardTier | null): boolean => true;
const visibleForStarterAndAbove = (tier: WizardTier | null): boolean =>
  tier !== 'starter' && tier !== null;
const hiddenForEveryTier = (_tier: WizardTier | null): boolean => false;

// ---------------------------------------------------------------------------
// Default payloads (per spec §"Visibilidad por tier")
// ---------------------------------------------------------------------------

const STEP_3_DEFAULT_PAYLOAD: Record<string, unknown> = {
  servicios: [],
  // `precio_tipo` is the global default applied when a cliente with a
  // hidden Step 3 asks about pricing. The spec calls for `consultar` so
  // the bot always routes pricing queries to a human.
  precio_tipo: 'consultar',
};

const STEP_7_DEFAULT_PAYLOAD: Record<string, unknown> = {
  reglas: [],
  fallback_sin_respuesta: 'derivar',
};

// Steps 1, 2, 4, 5, 6, 8, 9, 10, 11 — no tier-driven defaults. The cliente
// owns the payload; null/undefined is the right cold-start state.
const NO_DEFAULT: Record<string, unknown> = {};

// Step 12 has no payload in v1 (deferred to v1.1).
const STEP_12_DEFAULT_PAYLOAD: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const CHATBOT_STEPS: Readonly<Record<WizardStepNumber, WizardStepDefinition>> =
  Object.freeze({
    1: {
      number: 1,
      key: '1',
      label: 'Perfil del negocio',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Nombre comercial, sector, web: el bot lo repite tal cual, pero un
      // dato mal puesto aquí no le hace prometer ni negar nada — solo lo
      // corrige el propio cliente en el siguiente guardado.
      autoApprovable: false,
    },
    2: {
      number: 2,
      key: '2',
      label: 'Personalidad y límites',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Nunca automático: aquí es donde el cliente le dice al bot qué
      // tono usar y, sobre todo, qué NO puede prometer. Es juicio, no un
      // dato objetivo — exactamente lo que la revisión humana existe
      // para mirar.
      autoApprovable: false,
    },
    3: {
      number: 3,
      key: '3',
      label: 'Servicios y tarifas',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForStarterAndAbove,
      defaultPayload: STEP_3_DEFAULT_PAYLOAD,
      // Bajo riesgo: un precio mal puesto se corrige en la siguiente
      // conversación, no compromete al negocio frente a un tercero.
      autoApprovable: true,
    },
    4: {
      number: 4,
      key: '4',
      label: 'FAQ',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Bajo riesgo: son las respuestas que el propio cliente ya escribió
      // para que el bot las repita — no hay nada que un operador esté
      // juzgando mejor que el negocio que las redactó.
      autoApprovable: true,
    },
    5: {
      number: 5,
      key: '5',
      label: 'Horario',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Bajo riesgo: un horario equivocado decepciona a un cliente que
      // llama fuera de hora, no le compromete a nada.
      autoApprovable: true,
    },
    6: {
      number: 6,
      key: '6',
      label: 'Captación de leads',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // No está en la lista del informe, y a propósito: un email de aviso
      // mal puesto pierde leads en silencio, no es un fallo que el propio
      // cliente note para corregirlo solo.
      autoApprovable: false,
    },
    7: {
      number: 7,
      key: '7',
      label: 'Derivación',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForStarterAndAbove,
      defaultPayload: STEP_7_DEFAULT_PAYLOAD,
      // Decide cuándo el bot pasa la conversación a una persona: un fallo
      // aquí dilata una alerta o la manda al sitio equivocado.
      autoApprovable: false,
    },
    8: {
      number: 8,
      key: '8',
      label: 'Canales',
      block: 'comportamiento',
      requiredForReady: false,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Qué canales atiende el bot: una decisión operativa, no algo que
      // el cliente esté describiendo mal por accidente.
      autoApprovable: false,
    },
    9: {
      number: 9,
      key: '9',
      label: 'Mensajes',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Las frases que el bot dice tal cual, primera persona del negocio.
      // El propio texto de venta de este WP-XX habla de "lo que promete
      // el bot": esto es justo eso.
      autoApprovable: false,
    },
    10: {
      number: 10,
      key: '10',
      label: 'Cumplimiento',
      block: 'activacion',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Nunca automático: RGPD, aviso legal, lo que el bot puede y no
      // puede tratar. Un error aquí no lo nota el cliente — lo nota un
      // regulador, y para entonces ya es tarde.
      autoApprovable: false,
    },
    11: {
      number: 11,
      key: '11',
      label: 'Pruebas',
      block: 'activacion',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
      // Es la comprobación de que todo lo anterior funciona junto — el
      // paso menos indicado para saltarse precisamente la comprobación.
      autoApprovable: false,
    },
    12: {
      number: 12,
      key: '12',
      label: 'Integraciones (Próximamente · v1.1)',
      block: 'activacion',
      requiredForReady: false,
      v11Deferred: true,
      visibleFor: hiddenForEveryTier,
      defaultPayload: STEP_12_DEFAULT_PAYLOAD,
      // Diferido a v1.1: no se construye en v1, así que nunca hay nada
      // que aprobar aquí, automático o no.
      autoApprovable: false,
    },
  });

export const CHATBOT_MILESTONES: readonly string[] = Object.freeze(['T+0', 'T+3', 'T+7', 'T+14']);

export const CHATBOT_BLOCKS: readonly ('identidad' | 'comportamiento' | 'activacion')[] =
  Object.freeze(['identidad', 'comportamiento', 'activacion']);
