import { z } from 'zod';

// =============================================================================
// Web brief — validation for the 'web' product's standalone intake form
// (see prisma/schema.prisma's WebBrief model comment for why this doesn't
// reuse the chatbot wizard's per-step Zod schema registry). One schema for
// the whole form, not one per step — there's only one step.
//
// Only businessName, goal, and pagesNeeded (at least one) are required for
// a first submission; everything else can be filled in later via support.
// A client can always come back and edit/resubmit — this schema doesn't
// distinguish 'draft' from 'submitted' validation strictness on purpose,
// the route layer decides what `submit: true` requires.
// =============================================================================

const optionalTrimmed = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v == null ? undefined : String(v).trim()),
    z.string().max(max).optional(),
  );

export const GOAL_OPTIONS = ['vender', 'leads', 'informar', 'reservas', 'otro'] as const;
export const GOAL_LABELS: Record<(typeof GOAL_OPTIONS)[number], string> = {
  vender: 'Vender productos o servicios',
  leads: 'Generar contactos (leads)',
  informar: 'Informar / presencia de marca',
  reservas: 'Reservas o citas',
  otro: 'Otro',
};

export const CONTENT_PROVIDED_BY_OPTIONS = ['cliente', 'kairikos', 'mixto'] as const;
export const CONTENT_PROVIDED_BY_LABELS: Record<(typeof CONTENT_PROVIDED_BY_OPTIONS)[number], string> = {
  cliente: 'Yo envío los textos',
  kairikos: 'Que los redacte Kairikos',
  mixto: 'Un poco de cada uno',
};
export const PAGE_OPTIONS = [
  'Inicio',
  'Servicios',
  'Sobre nosotros',
  'Contacto',
  'Blog',
  'Precios',
  'Testimonios',
  'Otro',
] as const;
export const INTEGRATION_OPTIONS = [
  'WhatsApp',
  'Calendario de citas',
  'CRM',
  'Formulario de contacto',
  'Pagos online',
  'Otro',
] as const;

export const webBriefSchema = z.object({
  businessName: z.string().trim().min(1, 'required').max(160),
  vertical: optionalTrimmed(80),
  goal: z.enum(GOAL_OPTIONS, { errorMap: () => ({ message: 'required' }) }),
  targetAudience: optionalTrimmed(500),
  hasExistingBrand: z.boolean().optional(),
  brandAssetsNote: optionalTrimmed(1000),
  pagesNeeded: z.array(z.string().max(60)).min(1, 'required'),
  otherPagesNote: optionalTrimmed(300),
  contentProvidedBy: z.enum(CONTENT_PROVIDED_BY_OPTIONS).optional(),
  desiredDomain: optionalTrimmed(200),
  referenceWebsites: optionalTrimmed(1500),
  integrationsNeeded: z.array(z.string().max(60)).optional().default([]),
  otherIntegrationsNote: optionalTrimmed(300),
  additionalNotes: optionalTrimmed(2000),
  // The route layer only requires the fields above when this is true —
  // a draft save can be arbitrarily incomplete.
  submit: z.boolean(),
});

export type WebBriefInput = z.infer<typeof webBriefSchema>;

// A draft save must still be *shaped* right (no wrong types), but doesn't
// need to satisfy required-field constraints. NOT derived via
// `webBriefSchema.partial()` — `.partial()` only makes each KEY optional,
// it doesn't relax the validators a key's VALUE still has to pass when
// present (e.g. pagesNeeded would keep its `.min(1)`), so an explicit
// `pagesNeeded: []` — the form's own initial state before the client
// checks any boxes — failed a "save draft" click on an otherwise-empty
// form. Every field here is genuinely unconstrained instead.
export const webBriefDraftSchema = z.object({
  businessName: optionalTrimmed(160),
  vertical: optionalTrimmed(80),
  goal: z.string().max(40).optional(),
  targetAudience: optionalTrimmed(500),
  hasExistingBrand: z.boolean().optional(),
  brandAssetsNote: optionalTrimmed(1000),
  pagesNeeded: z.array(z.string().max(60)).optional().default([]),
  otherPagesNote: optionalTrimmed(300),
  contentProvidedBy: z.string().max(40).optional(),
  desiredDomain: optionalTrimmed(200),
  referenceWebsites: optionalTrimmed(1500),
  integrationsNeeded: z.array(z.string().max(60)).optional().default([]),
  otherIntegrationsNote: optionalTrimmed(300),
  additionalNotes: optionalTrimmed(2000),
  submit: z.literal(false),
});
