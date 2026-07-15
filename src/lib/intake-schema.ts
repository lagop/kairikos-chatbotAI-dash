import { z } from "zod";

export const SECTORS = [
  "abogado",
  "clinica",
  "inmobiliaria",
  "gestoria",
  "ecommerce",
  "otro",
] as const;

export type Sector = (typeof SECTORS)[number];

export const SECTOR_LABELS: Record<Sector, string> = {
  abogado: "Abogado",
  clinica: "Clínica dental / médica",
  inmobiliaria: "Inmobiliaria",
  gestoria: "Gestoría",
  ecommerce: "Tienda online",
  otro: "Otro",
};

export const TIMEZONES = [
  "Europe/Madrid",
  "Europe/Lisbon",
  "America/Mexico_City",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
] as const;

export type Timezone = (typeof TIMEZONES)[number];

export const CHANNEL_OPTIONS = ["web_chat", "whatsapp", "instagram"] as const;
export type Channel = (typeof CHANNEL_OPTIONS)[number];

export const TONE_OPTIONS = [
  "formal",
  "semiformal",
  "casual",
  "friendly",
] as const;
export type Tone = (typeof TONE_OPTIONS)[number];

const daySchema = z.object({
  enabled: z.boolean(),
  openAM: z.string().optional(),
  closeAM: z.string().optional(),
  openPM: z.string().optional(),
  closePM: z.string().optional(),
});

export const intakeSchema = z.object({
  // P1 — Identidad del negocio
  business_name: z
    .string()
    .min(2, "Mínimo 2 caracteres")
    .max(80, "Máximo 80 caracteres"),
  legal_name: z.string().max(120).optional(),
  sector: z.enum(SECTORS, { error: "Selecciona un sector" }),

  // P2 — FAQs del sector
  faqs: z
    .array(z.object({ question: z.string().min(5), answer: z.string().min(5) }))
    .min(10, "Mínimo 10 preguntas")
    .max(50, "Máximo 50 preguntas"),

  // P3 — Canales
  channels: z
    .array(z.enum(CHANNEL_OPTIONS))
    .min(1, "Selecciona al menos un canal"),
  whatsapp_number: z.string().optional(),
  instagram_handle: z.string().optional(),

  // P4 — Tono y estilo
  tone: z.enum(TONE_OPTIONS, { error: "Selecciona un tono" }),

  // P5 — Horario operativo
  timezone: z.enum(TIMEZONES, { error: "Selecciona tu zona horaria" }),
  schedule: z.object({
    monday: daySchema,
    tuesday: daySchema,
    wednesday: daySchema,
    thursday: daySchema,
    friday: daySchema,
    saturday: daySchema,
    sunday: daySchema,
  }),

  // P6 — Datos de facturación
  billing_email: z.string().email("Correo electrónico inválido"),
  billing_name: z.string().min(2, "Mínimo 2 caracteres"),
  billing_nif: z.string().optional(),
  billing_address: z.string().min(5, "Dirección demasiado corta"),

  // P7 — Consentimiento RGPD
  rgpd_consent: z.literal(true, {
    error: "Debes aceptar la política de privacidad",
  }),
});

export type IntakeFormData = z.infer<typeof intakeSchema>;

export const STEPS = [
  "Identidad del negocio",
  "FAQs del sector",
  "Canales de contacto",
  "Tono y estilo",
  "Horario operativo",
  "Datos de facturación",
  "Confirmación",
] as const;

export const STORAGE_KEY = "kairikos-chatbot-intake";
