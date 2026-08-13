import { z } from 'zod';

const trimmed = (max: number) => z.string().trim().max(max);
const optionalString = (max: number) => z.preprocess(
  (v) => (v === '' || v == null ? undefined : String(v).trim()),
  z.string().max(max).optional(),
);
const requiredString = (min: number, max: number) =>
  z.string().trim().min(min, 'required').max(max, 'maxLength');

const urlOpt = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || /^https:\/\//.test(v), 'url');

const emailOpt = z.preprocess(
  (v) => (v === '' || v == null ? undefined : String(v).trim()),
  z.string().email().optional(),
);

const numberOpt = (min: number) => z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  },
  z.number().min(min).optional(),
);

const numberReq = (min: number) => z.preprocess(
  (v) => {
    if (v === '' || v == null) return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  },
  z.number().min(min),
);

const timeFormat = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalidTime');

const checkArray = (values: readonly string[]) => z.array(z.string()).min(1, 'required');

// ---------- Step 1: Perfil del negocio ----------
export const step1Schema = z.object({
  vertical: z.enum(['abogado', 'clinica', 'inmobiliaria', 'gestoria', 'otro'], {
    errorMap: () => ({ message: 'required' }),
  }),
  nombre_comercial: requiredString(2, 80),
  razon_social: z.preprocess(
    (v) => (v === '' || v == null ? undefined : String(v).trim()),
    z.string().max(120).optional(),
  ),
  web: urlOpt,
  idiomas: checkArray(['ES', 'EN', 'DE']),
  idioma_por_defecto: z.string().min(1, 'required'),
}).refine(
  (data) => data.idiomas.includes(data.idioma_por_defecto),
  { path: ['idioma_por_defecto'], message: 'valueMismatch' },
);

// ---------- Step 2: Personalidad y límites ----------
export const step2Schema = z.object({
  tono: z.enum(['formal', 'cercano'], { errorMap: () => ({ message: 'required' }) }),
  tratamiento: z.enum(['tu', 'usted'], { errorMap: () => ({ message: 'required' }) }),
  ejemplos_respuesta: z
    .array(
      z.object({
        texto: z.string().trim().min(1).max(300, 'maxLength'),
      }),
    )
    .max(3, 'maxItems')
    .optional()
    .default([]),
  temas_prohibidos: z.object({
    checklist: z.array(z.string()).min(1, 'checkboxRequired'),
    libre: z.preprocess(
      (v) => (v === '' || v == null ? undefined : String(v).trim()),
      z.string().max(500).optional(),
    ),
  }),
  disclaimer: z.preprocess(
    (v) => (v === '' || v == null ? undefined : String(v).trim()),
    z.string().max(300, 'maxLength').optional(),
  ),
});

// ---------- Step 3: Servicios y tarifas ----------
const servicioSchema = z.object({
  nombre: requiredString(2, 80),
  descripcion: requiredString(1, 300),
  precio_tipo: z.enum(['fijo', 'desde', 'consultar'], { errorMap: () => ({ message: 'required' }) }),
  precio_valor: z.preprocess(
    (v) => {
      if (v === '' || v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    },
    z.number().min(0).optional(),
  ),
  duracion_min: z.preprocess(
    (v) => {
      if (v === '' || v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    },
    z.number().min(0).optional(),
  ),
});

export const step3Schema = z
  .object({
    servicios: z.array(servicioSchema),
    portal_propiedades_url: urlOpt,
    vertical: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.vertical === 'inmobiliaria') {
      if (!data.portal_propiedades_url || data.portal_propiedades_url.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['portal_propiedades_url'],
          message: 'required',
        });
      }
    } else {
      if (data.servicios.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['servicios'],
          message: 'minItems',
        });
      }
    }
    for (let i = 0; i < data.servicios.length; i += 1) {
      const s = data.servicios[i];
      if ((s.precio_tipo === 'fijo' || s.precio_tipo === 'desde') && (s.precio_valor === undefined || s.precio_valor === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['servicios', i, 'precio_valor'],
          message: 'required',
        });
      }
    }
  });

// ---------- Step 4: FAQ ----------
export const step4Schema = z
  .object({
    faq_items: z.array(
      z.object({
        pregunta: requiredString(1, 200),
        respuesta: requiredString(1, 1000),
      }),
    ),
    faq_file: z.string().optional(),
    faq_paste: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.faq_items.length === 0 && !data.faq_file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['faq_items'],
        message: 'minItems',
      });
    }
  });

// ---------- Step 5: Horario ----------
const horarioFranjaSchema = z
  .object({
    dias: z.array(z.string()).min(1, 'required'),
    hora_inicio: timeFormat,
    hora_fin: timeFormat,
  })
  .refine((v) => v.hora_inicio < v.hora_fin, { path: ['hora_fin'], message: 'invalidTime' });

export const step5Schema = z
  .object({
    timezone: z.string().min(1, 'required'),
    horario: z.array(horarioFranjaSchema).min(1, 'minItems'),
    comportamiento_fuera_horario: z.enum(
      ['solo_informa', 'captura_lead', 'mensaje_personalizado'],
      { errorMap: () => ({ message: 'required' }) },
    ),
    mensaje_fuera_horario: z.preprocess(
      (v) => (v === '' || v == null ? undefined : String(v).trim()),
      z.string().max(300, 'maxLength').optional(),
    ),
  })
  .superRefine((data, ctx) => {
    if (
      data.comportamiento_fuera_horario === 'mensaje_personalizado' &&
      !data.mensaje_fuera_horario
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mensaje_fuera_horario'],
        message: 'required',
      });
    }
  });

// ---------- Step 6: Captación de leads ----------
export const step6Schema = z
  .object({
    datos_solicitados: z
      .array(z.enum(['nombre', 'telefono', 'email', 'motivo']))
      .min(1, 'checkboxRequired'),
    campos_extra: z
      .array(z.string().max(80))
      .max(10, 'maxItems')
      .optional()
      .default([]),
    momento_captura: z.enum(['al_inicio', 'antes_de_derivar', 'a_peticion'], {
      errorMap: () => ({ message: 'required' }),
    }),
    destino_lead: z.literal('email'),
    email_notificacion: z.preprocess(
      (v) => (v === '' || v == null ? undefined : String(v).trim()),
      z.string().min(1, 'required'),
    ),
    texto_consentimiento: z.string().min(1, 'required').max(2000, 'maxLength'),
  })
  .superRefine((data, ctx) => {
    if (data.email_notificacion) {
      const parts = data.email_notificacion.split(',').map((p) => p.trim()).filter(Boolean);
      const bad = parts.find((p) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p));
      if (bad) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['email_notificacion'],
          message: 'email',
        });
      }
    }
  });

// ---------- Step 7: Derivación ----------
export const step7Schema = z.object({
  reglas: z
    .array(
      z
        .object({
          condicion_tipo: z.enum(
            ['tema_prohibido', 'palabra_clave', 'fuera_horario', 'peticion_explicita'],
            { errorMap: () => ({ message: 'required' }) },
          ),
          valor: z.union([z.string(), z.array(z.string())]).optional(),
          accion: z.enum(['derivar_humano', 'capturar_lead', 'mensaje_fijo'], {
            errorMap: () => ({ message: 'required' }),
          }),
          destino: z.string().optional(),
        })
        .superRefine((r, ctx) => {
          if (r.condicion_tipo === 'palabra_clave') {
            const has =
              (typeof r.valor === 'string' && r.valor.trim().length > 0) ||
              (Array.isArray(r.valor) && r.valor.length > 0);
            if (!has) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['valor'], message: 'required' });
            }
          }
          if (r.accion === 'derivar_humano' && (!r.destino || !r.destino.trim())) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destino'], message: 'required' });
          }
        }),
    )
    .optional()
    .default([]),
  fallback_sin_respuesta: z.enum(['derivar', 'pedir_reformular', 'capturar_lead'], {
    errorMap: () => ({ message: 'required' }),
  }),
});

// ---------- Step 8: Canales ----------
export const step8Schema = z
  .object({
    canal_web: z.boolean().optional().default(false),
    canal_whatsapp: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.canal_web && !data.canal_whatsapp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canal_web'],
        message: 'required',
      });
    }
  });

// ---------- Step 9: Mensajes ----------
export const step9Schema = z.object({
  mensaje_bienvenida: requiredString(1, 300),
  prompts_sugeridos: z
    .array(z.string().min(1).max(60))
    .max(5, 'maxItems')
    .optional()
    .default([]),
  mensaje_despedida: z.preprocess(
    (v) => (v === '' || v == null ? undefined : String(v).trim()),
    z.string().max(200, 'maxLength').optional(),
  ),
});

// ---------- Step 10: Cumplimiento ----------
export const step10Schema = z
  .object({
    responsable_tratamiento: requiredString(1, 120),
    email_dpo: emailOpt,
    url_politica_privacidad: z.string().trim().min(1, 'required').regex(/^https:\/\//, 'url'),
    retencion_leads_dias: z.preprocess(
      (v) => {
        if (v === '' || v == null) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      },
      z.number().min(0).optional(),
    ),
    plantilla_base: z.string().optional(),
    bloque_salud: z.string().optional(),
    bloque_secreto_profesional: z.string().optional(),
    vertical: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.vertical === 'clinica' || data.vertical === 'abogado') &&
      !data.email_dpo
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email_dpo'], message: 'required' });
    }
  });

// ---------- Step 11: Pruebas ----------
export const step11Schema = z.object({
  test_qa: z
    .array(
      z.object({
        pregunta: requiredString(1, 200),
        respuesta_esperada: z.string().max(500).optional(),
      }),
    )
    .optional()
    .default([]),
});

export const stepSchemas = {
  1: step1Schema,
  2: step2Schema,
  3: step3Schema,
  4: step4Schema,
  5: step5Schema,
  6: step6Schema,
  7: step7Schema,
  8: step8Schema,
  9: step9Schema,
  10: step10Schema,
  11: step11Schema,
} as const;

export type StepSchemaKey = keyof typeof stepSchemas;

// WP-15 — product-keyed registry over the same `stepSchemas` map. Only
// 'chatbot' has step schemas today (the other four products have no
// wizard yet — see src/lib/catalogs/index.ts for the matching catalog
// registry). Partial, not a full Record<ProductCode, ...>, so a product
// without schemas is simply absent rather than mapped to an empty object
// — `SCHEMA_REGISTRY.web` is `undefined`, not `{}`, which is the honest
// "no schemas exist" signal for a caller to check.
export const SCHEMA_REGISTRY: Partial<Record<'chatbot', typeof stepSchemas>> = {
  chatbot: stepSchemas,
};

export type Step1Input = z.infer<typeof step1Schema>;
export type Step2Input = z.infer<typeof step2Schema>;
export type Step3Input = z.infer<typeof step3Schema>;
export type Step4Input = z.infer<typeof step4Schema>;
export type Step5Input = z.infer<typeof step5Schema>;
export type Step6Input = z.infer<typeof step6Schema>;
export type Step7Input = z.infer<typeof step7Schema>;
export type Step8Input = z.infer<typeof step8Schema>;
export type Step9Input = z.infer<typeof step9Schema>;
export type Step10Input = z.infer<typeof step10Schema>;
export type Step11Input = z.infer<typeof step11Schema>;

// ---------- Compliance templates (Step 10 ↔ Step 6) ----------

export const COMPLIANCE_TEMPLATES: Record<string, { plantilla_base: string }> = {
  default: {
    plantilla_base:
      'He leído y acepto la política de privacidad. Autorizo el tratamiento de mis datos personales con la finalidad de gestionar mi consulta.',
  },
  clinica: {
    plantilla_base:
      'He leído y acepto la política de privacidad. Autorizo el tratamiento de mis datos de salud con la finalidad de gestionar mi consulta, conforme al art. 9 del RGPD.',
  },
  abogado: {
    plantilla_base:
      'He leído y acepto la política de privacidad. Autorizo el tratamiento de mis datos personales con la finalidad de gestionar mi consulta, dentro del marco del secreto profesional.',
  },
};
