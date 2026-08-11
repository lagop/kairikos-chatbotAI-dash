"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useForm, useFieldArray, useWatch, type SubmitHandler, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  intakeSchema,
  type IntakeFormData,
  STEPS,
  SECTOR_LABELS,
  SECTOR_OPTIONS,
  CHANNEL_OPTIONS,
  VOICE_TONE_OPTIONS,
  VOICE_TONE_LABELS,
  PRONOUN_OPTIONS,
  PRONOUN_LABELS,
  LANGUAGE_OPTIONS,
  OUT_OF_HOURS_OPTIONS,
  WHATSAPP_VERIFIED_OPTIONS,
  WEB_INSTALL_OPTIONS,
  STORAGE_KEY,
  type Sector,
  type VoiceTone,
  type Pronoun,
} from "@/lib/intake-schema";

const defaultValues: IntakeFormData = {
  business_name: "",
  legal_name: "",
  sector: "clínica dental",
  short_description: "",
  website_url: "",
  logo_upload: "",
  voice_tone: "cercano",
  pronoun: "tú",
  language: ["español"],
  forbidden_words: "",
  business_hours_weekday: "",
  business_hours_weekend: "",
  holidays_url_or_text: "",
  out_of_hours_behavior: "dejar mensaje",
  faqs: Array.from({ length: 10 }, () => ({ q: "", a: "" })),
  channels_enabled: ["web"],
  whatsapp_business_number: "",
  whatsapp_business_verified: undefined,
  instagram_handle: "",
  web_install_target: undefined,
  human_handoff_email: "",
  human_handoff_whatsapp: "",
  human_handoff_hours: "",
  escalation_triggers: "",
  gdpr_responsible_email: "",
  privacy_url: "",
};

function loadSaved(): Partial<IntakeFormData> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normalizePrivacyUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (typeof (window as unknown as { posthog?: { capture: (e: string, p?: Record<string, unknown>) => void } }).posthog?.capture === "function") {
    (window as unknown as { posthog: { capture: (e: string, p?: Record<string, unknown>) => void } }).posthog.capture(event, properties);
  }
  if (typeof (window as unknown as { gtag?: (cmd: string, action: string, params?: Record<string, unknown>) => void }).gtag === "function") {
    (window as unknown as { gtag: (cmd: string, action: string, params?: Record<string, unknown>) => void }).gtag("event", event, properties);
  }
}

function ProgressBar({
  steps,
  currentStep,
}: {
  steps: readonly string[];
  currentStep: number;
}) {
  return (
    <div className="intake-progress" role="progressbar" aria-valuenow={currentStep + 1} aria-valuemin={1} aria-valuemax={steps.length}>
      <div className="intake-progress-track">
        <div
          className="intake-progress-fill"
          style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
        />
      </div>
      <div className="intake-progress-steps">
        {steps.map((label, i) => (
          <div
            key={i}
            className={`intake-progress-step ${i === currentStep ? "active" : ""} ${i < currentStep ? "done" : ""}`}
          >
            <span className="intake-progress-dot" aria-hidden="true" />
            <span className="intake-progress-label">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepField({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="intake-field">
      <label className="intake-label">
        {label}
        {required && <span className="intake-required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && (
        <p className="intake-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function IntakePage() {
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const formCardRef = useRef<HTMLDivElement | null>(null);

  const {
    register,
    control,
    handleSubmit,
    trigger,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<IntakeFormData>({
    resolver: zodResolver(intakeSchema),
    defaultValues: { ...defaultValues, ...loadSaved() },
    mode: "onBlur",
  });

  const { fields: faqFields, append, remove } = useFieldArray({
    control,
    name: "faqs",
  });

  const watchedSector = useWatch({ control, name: "sector" });
  const watchedChannels = useWatch({ control, name: "channels_enabled" });
  const watchedLanguage = useWatch({ control, name: "language" });

  const reg = useCallback(
    (name: keyof IntakeFormData) => {
      const hasError = Boolean((errors as Record<string, unknown>)[name as string]);
      return {
        ...register(name),
        "aria-invalid": hasError ? ("true" as const) : undefined,
      };
    },
    [register, errors]
  );

  // Normalize privacy_url on blur so users typing "kairikos.com" pass validation.
  const handlePrivacyUrlBlur = useCallback(() => {
    const raw = getValues("privacy_url");
    const normalized = normalizePrivacyUrl(raw);
    if (typeof normalized === "string" && normalized !== raw) {
      setValue("privacy_url", normalized, { shouldValidate: true });
    }
  }, [getValues, setValue]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(getValues()));
      } catch {}
    }, 800);
    return () => clearTimeout(timeout);
  }, [watchedSector, getValues]);

  const focusFirstError = useCallback(() => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      const card = formCardRef.current;
      const firstInvalid = card?.querySelector<HTMLElement>(
        ".intake-input[aria-invalid='true'], .intake-select[aria-invalid='true'], .intake-textarea[aria-invalid='true']"
      );
      if (firstInvalid) {
        firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
        firstInvalid.focus({ preventScroll: true });
      } else {
        card?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, []);

  const goNext = useCallback(async () => {
    setSummaryError(null);
    const stepFields: Path<IntakeFormData>[][] = [
      // P1 — Identidad
      ["business_name", "sector", "short_description"],
      // P2 — FAQs
      ["faqs"],
      // P3 — Canales
      ["channels_enabled"],
      // P4 — Tono y estilo
      ["voice_tone", "pronoun", "language"],
      // P5 — Horario
      ["business_hours_weekday", "business_hours_weekend", "out_of_hours_behavior"],
      // P6 — Handoff
      ["human_handoff_email", "human_handoff_hours", "escalation_triggers"],
      // P7 — Privacidad
      ["gdpr_responsible_email", "privacy_url"],
    ];
    const fieldsToValidate = stepFields[currentStep] as readonly Path<IntakeFormData>[];
    const valid = await trigger(fieldsToValidate as unknown as Parameters<typeof trigger>[0]);
    if (!valid) {
      setSummaryError(
        "Faltan campos obligatorios en este paso. Revisa los marcados en rojo antes de continuar."
      );
      focusFirstError();
      return;
    }
    trackEvent("intake_step_complete", { step: currentStep + 1 });
    setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [currentStep, trigger, focusFirstError]);

  const goPrev = useCallback(() => {
    setCurrentStep((s) => Math.max(s - 1, 0));
  }, []);

  const onSubmit: SubmitHandler<IntakeFormData> = async (data) => {
    setSubmitting(true);
    try {
      trackEvent("intake_submit_success", { sector: data.sector });
      const res = await fetch("/api/public/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        localStorage.removeItem(STORAGE_KEY);
        setSubmitted(true);
        window.location.href = "/chatbot-gracias/?ref=intake";
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      trackEvent("intake_submit_error", { sector: data.sector });
      alert("Hubo un error al enviar el formulario. Por favor, inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  };

  const onInvalid = useCallback(() => {
    const errorCount = Object.keys(errors).length;
    setSummaryError(
      `No se puede enviar el formulario: ${errorCount} ${errorCount === 1 ? "campo obligatorio" : "campos obligatorios"} sin completar. Revisa los pasos anteriores.`
    );
    focusFirstError();
  }, [errors, focusFirstError]);

  const toggleLanguage = (lang: string) => {
    const current = getValues("language") || [];
    if (current.includes(lang as typeof LANGUAGE_OPTIONS[number])) {
      setValue(
        "language",
        current.filter((l) => l !== lang) as typeof current,
        { shouldValidate: true }
      );
    } else {
      setValue(
        "language",
        [...current, lang] as typeof current,
        { shouldValidate: true }
      );
    }
  };

  if (submitted) {
    return (
      <div className="intake-page">
        <div className="intake-card">
          <div className="intake-success">
            <div className="intake-success-icon" aria-hidden="true">✓</div>
            <h2>¡Formulario enviado!</h2>
            <p>Te hemos enviado un enlace mágico a tu correo electrónico.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="intake-page">
      <div className="intake-header">
        <h1 className="intake-title">Configura tu chatbot</h1>
        <p className="intake-subtitle">
          Responde 7 preguntas para que configuremos tu chatbot personalizado.
        </p>
      </div>

      <div className="intake-card" ref={formCardRef}>
        <ProgressBar steps={STEPS} currentStep={currentStep} />

        {summaryError && (
          <div className="intake-summary-error" role="alert" aria-live="assertive">
            <span className="intake-summary-error-icon" aria-hidden="true">!</span>
            <span>{summaryError}</span>
            <button
              type="button"
              className="intake-summary-error-close"
              onClick={() => setSummaryError(null)}
              aria-label="Cerrar aviso"
            >
              ×
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
          {currentStep === 0 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Identidad del negocio</h2>
              <StepField label="Nombre del negocio" required error={errors.business_name?.message}>
                <input
                  id="business_name"
                  type="text"
                  className="intake-input"
                  placeholder="Ej: Clínica Dental Martínez"
                  {...reg("business_name")}
                  aria-required="true"
                />
              </StepField>
              <StepField label="Nombre legal (opcional)" error={errors.legal_name?.message}>
                <input
                  id="legal_name"
                  type="text"
                  className="intake-input"
                  placeholder="Ej: Martínez López S.L.P."
                  {...register("legal_name")}
                />
              </StepField>
              <StepField label="Sector" required error={errors.sector?.message}>
                <select
                  id="sector"
                  className="intake-select"
                  {...reg("sector")}
                  aria-required="true"
                >
                  <option value="">Selecciona tu sector</option>
                  {SECTOR_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {SECTOR_LABELS[s as Sector]}
                    </option>
                  ))}
                </select>
              </StepField>
              <StepField label="Descripción corta del negocio" required error={errors.short_description?.message}>
                <textarea
                  id="short_description"
                  className="intake-input intake-textarea"
                  placeholder="Ej: Somos una clínica dental familiar en el centro de Madrid, especializada en ortodoncia y estética dental."
                  rows={3}
                  maxLength={280}
                  {...reg("short_description")}
                  aria-required="true"
                />
                <small className="intake-hint">Máx. 280 caracteres</small>
              </StepField>
              <StepField label="URL de tu web (opcional)" error={errors.website_url?.message}>
                <input
                  id="website_url"
                  type="url"
                  className="intake-input"
                  placeholder="https://www.tuclinica.com"
                  {...register("website_url")}
                />
              </StepField>
            </div>
          )}

          {currentStep === 1 && (
            <div className="intake-step">
              <h2 className="intake-step-title">FAQs del sector</h2>
              <p className="intake-step-desc">
                Añade las preguntas más frecuentes de tus clientes. Mínimo 10, máximo 15.
              </p>
              <div className="intake-faq-list">
                {faqFields.map((field, i) => (
                  <div key={field.id} className="intake-faq-item">
                    <span className="intake-faq-num">{i + 1}</span>
                    <div className="intake-faq-fields">
                      <input
                        type="text"
                        className="intake-input"
                        placeholder="Pregunta"
                        {...register(`faqs.${i}.q` as const)}
                        aria-label={`Pregunta ${i + 1}`}
                      />
                      <textarea
                        className="intake-input intake-textarea"
                        placeholder="Respuesta"
                        rows={2}
                        {...register(`faqs.${i}.a` as const)}
                        aria-label={`Respuesta ${i + 1}`}
                      />
                    </div>
                    {faqFields.length > 10 && (
                      <button
                        type="button"
                        className="intake-faq-remove"
                        onClick={() => remove(i)}
                        aria-label={`Eliminar pregunta ${i + 1}`}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {faqFields.length < 15 && (
                <button
                  type="button"
                  className="intake-add-btn"
                  onClick={() => append({ q: "", a: "" })}
                >
                  + Añadir pregunta
                </button>
              )}
              {errors.faqs && typeof errors.faqs.message === "string" && (
                <p className="intake-error" role="alert">{errors.faqs.message}</p>
              )}
            </div>
          )}

          {currentStep === 2 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Canales de contacto</h2>
              <p className="intake-step-desc">
                ¿En qué canales quieres que hablen tus clientes con el chatbot?
              </p>
              <div className="intake-channels">
                {CHANNEL_OPTIONS.map((ch) => {
                  const checked = watchedChannels?.includes(ch) ?? false;
                  return (
                    <label key={ch} className={`intake-channel ${checked ? "checked" : ""}`}>
                      <input
                        type="checkbox"
                        value={ch}
                        {...register("channels_enabled")}
                        className="intake-checkbox"
                      />
                      <span className="intake-channel-label">
                        {ch === "web" ? "Chat en tu web" : ch === "whatsapp" ? "WhatsApp" : "Instagram"}
                      </span>
                    </label>
                  );
                })}
              </div>
              {errors.channels_enabled && (
                <p className="intake-error" role="alert">{errors.channels_enabled.message}</p>
              )}

              {watchedChannels?.includes("whatsapp") && (
                <>
                  <StepField label="Número de WhatsApp Business" required error={errors.whatsapp_business_number?.message}>
                    <input
                      type="tel"
                      className="intake-input"
                      placeholder="+34612345678"
                      {...register("whatsapp_business_number")}
                    />
                    <small className="intake-hint">Formato E.164 (ej. +34612345678)</small>
                  </StepField>
                  <StepField label="¿Número verificado en Meta Business Manager?" required error={errors.whatsapp_business_verified?.message}>
                    <select
                      className="intake-select"
                      {...register("whatsapp_business_verified")}
                      aria-required="true"
                    >
                      <option value="">Selecciona</option>
                      <option value="sí">Sí, está verificado</option>
                      <option value="no">No, es un número normal</option>
                    </select>
                  </StepField>
                </>
              )}
              {watchedChannels?.includes("instagram") && (
                <StepField label="Usuario de Instagram" required error={errors.instagram_handle?.message}>
                  <input
                    type="text"
                    className="intake-input"
                    placeholder="@tu_empresa"
                    {...register("instagram_handle")}
                  />
                </StepField>
              )}
            </div>
          )}

          {currentStep === 3 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Tono y estilo</h2>
              <p className="intake-step-desc">
                ¿Cómo quieres que se comunique tu chatbot con los clientes?
              </p>

              <StepField label="Tono de voz" required error={errors.voice_tone?.message}>
                <div className="intake-tones">
                  {VOICE_TONE_OPTIONS.map((tone) => (
                    <label key={tone} className="intake-tone-option">
                      <input
                        type="radio"
                        value={tone}
                        {...register("voice_tone")}
                        className="intake-radio"
                      />
                      <span>{VOICE_TONE_LABELS[tone as VoiceTone]}</span>
                      <small>
                        {tone === "formal"
                          ? "Lenguaje profesional y respetuoso"
                          : tone === "cercano"
                          ? "Profesional pero cercano y amigable"
                          : "Desenfadado y directo"}
                      </small>
                    </label>
                  ))}
                </div>
              </StepField>

              <StepField label="Pronombre" required error={errors.pronoun?.message}>
                <div className="intake-pronouns">
                  {PRONOUN_OPTIONS.map((pronoun) => (
                    <label key={pronoun} className="intake-tone-option">
                      <input
                        type="radio"
                        value={pronoun}
                        {...register("pronoun")}
                        className="intake-radio"
                      />
                      <span>{PRONOUN_LABELS[pronoun as Pronoun]}</span>
                    </label>
                  ))}
                </div>
              </StepField>

              <StepField label="Idioma del chatbot" required error={errors.language?.message}>
                <div className="intake-languages">
                  {LANGUAGE_OPTIONS.map((lang) => {
                    const checked = watchedLanguage?.includes(lang) ?? false;
                    return (
                      <label key={lang} className={`intake-language ${checked ? "checked" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLanguage(lang)}
                          className="intake-checkbox"
                        />
                        <span>
                          {lang === "español" ? "Español" : lang === "catalán" ? "Catalán" : "Inglés"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </StepField>

              <StepField label="Palabras taboo (opcional)" error={errors.forbidden_words?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="Ej: presupuesto, presupuesto gratis, presupuesto sin compromiso"
                  {...register("forbidden_words")}
                />
                <small className="intake-hint">El chatbot no usará estas palabras en sus respuestas</small>
              </StepField>
            </div>
          )}

          {currentStep === 4 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Horario operativo</h2>

              <StepField label="Horario entre semana (L-V)" required error={errors.business_hours_weekday?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="Ej: 9:00 - 18:00"
                  {...reg("business_hours_weekday")}
                  aria-required="true"
                />
              </StepField>

              <StepField label="Horario fin de semana (S-D)" required error={errors.business_hours_weekend?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="Ej: 10:00 - 14:00 o cerrado"
                  {...reg("business_hours_weekend")}
                  aria-required="true"
                />
              </StepField>

              <StepField label="Festivos o vacaciones (opcional)" error={errors.holidays_url_or_text?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="Ej: Consultar calendario en https://..."
                  {...register("holidays_url_or_text")}
                />
              </StepField>

              <StepField label="Comportamiento fuera de horario" required error={errors.out_of_hours_behavior?.message}>
                <select
                  className="intake-select"
                  {...reg("out_of_hours_behavior")}
                  aria-required="true"
                >
                  <option value="">Selecciona una opción</option>
                  <option value="derivar a humano siguiente día">Derivar a humano (respuesta siguiente día laborable)</option>
                  <option value="dejar mensaje">Dejar mensaje para que el negocio responda</option>
                  <option value="cita automática">Permitir pedir cita automáticamente</option>
                </select>
              </StepField>
            </div>
          )}

          {currentStep === 5 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Handoff y escalación</h2>
              <p className="intake-step-desc">
                ¿Cómo debe actuar el chatbot cuando necesite derivar a un humano?
              </p>

              <StepField label="Email para derivaciones" required error={errors.human_handoff_email?.message}>
                <input
                  type="email"
                  className="intake-input"
                  placeholder="humano@tuempresa.com"
                  {...reg("human_handoff_email")}
                  aria-required="true"
                />
              </StepField>

              <StepField label="WhatsApp para derivaciones (opcional)" error={errors.human_handoff_whatsapp?.message}>
                <input
                  type="tel"
                  className="intake-input"
                  placeholder="+34612345678"
                  {...register("human_handoff_whatsapp")}
                />
                <small className="intake-hint">Formato E.164 (ej. +34612345678)</small>
              </StepField>

              <StepField label="Horario para derivaciones humanas" required error={errors.human_handoff_hours?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="Ej: L-V 9:00-18:00"
                  {...reg("human_handoff_hours")}
                  aria-required="true"
                />
              </StepField>

              <StepField label="Casos que requieren derivación humana" required error={errors.escalation_triggers?.message}>
                <textarea
                  className="intake-input intake-textarea"
                  placeholder="Ej: Quejas, devoluciones, presupuestos personalizados, citas canceladas"
                  rows={3}
                  {...reg("escalation_triggers")}
                  aria-required="true"
                />
              </StepField>

              <StepField label="¿En qué plataforma está tu web?" error={errors.web_install_target?.message}>
                <select className="intake-select" {...register("web_install_target")}>
                  <option value="">Selecciona una opción</option>
                  {WEB_INSTALL_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt === "WordPress" ? "WordPress" : opt === "Shopify" ? "Shopify" : opt === "otra" ? "Otra plataforma" : "No lo sé todavía"}
                    </option>
                  ))}
                </select>
              </StepField>
            </div>
          )}

          {currentStep === 6 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Privacidad y protección de datos</h2>
              <p className="intake-step-desc">
                Información sobre el responsable del tratamiento de datos.
              </p>

              <StepField label="Email del responsable de protección de datos" required error={errors.gdpr_responsible_email?.message}>
                <input
                  type="email"
                  className="intake-input"
                  placeholder="dpo@tuempresa.com"
                  {...reg("gdpr_responsible_email")}
                  aria-required="true"
                />
              </StepField>

              <StepField label="URL de tu política de privacidad" required error={errors.privacy_url?.message}>
                <input
                  type="url"
                  className="intake-input"
                  placeholder="https://www.tuempresa.com/politica-privacidad"
                  {...reg("privacy_url")}
                  onBlur={() => {
                    handlePrivacyUrlBlur();
                  }}
                  aria-required="true"
                />
                <small className="intake-hint">
                  Si no incluye esquema (https://) lo añadimos automáticamente.
                </small>
              </StepField>

              <div className="intake-review">
                <h3>Resumen de tu configuración</h3>
                <dl className="intake-review-list">
                  <div className="intake-review-row">
                    <dt>Negocio</dt>
                    <dd>{getValues("business_name")}</dd>
                  </div>
                  <div className="intake-review-row">
                    <dt>Sector</dt>
                    <dd>{SECTOR_LABELS[getValues("sector") as Sector]}</dd>
                  </div>
                  <div className="intake-review-row">
                    <dt>Preguntas FAQ</dt>
                    <dd>{getValues("faqs").filter((f) => f.q).length}</dd>
                  </div>
                  <div className="intake-review-row">
                    <dt>Canales</dt>
                    <dd>{getValues("channels_enabled").join(", ")}</dd>
                  </div>
                  <div className="intake-review-row">
                    <dt>Tono</dt>
                    <dd>{VOICE_TONE_LABELS[getValues("voice_tone") as VoiceTone]}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          <div className="intake-nav">
            {currentStep > 0 && (
              <button
                type="button"
                className="intake-btn intake-btn--secondary"
                onClick={goPrev}
              >
                Anterior
              </button>
            )}
            {currentStep < STEPS.length - 1 ? (
              <button
                type="button"
                className="intake-btn intake-btn--primary"
                onClick={goNext}
              >
                Siguiente
              </button>
            ) : (
              <button
                type="submit"
                className="intake-btn intake-btn--submit"
                disabled={submitting}
              >
                {submitting ? "Enviando..." : "Enviar y continuar"}
              </button>
            )}
          </div>
        </form>
      </div>

      <style jsx>{`
        .intake-page {
          min-height: 100vh;
          background: var(--color-bg-alt, #f7fafc);
          padding: 2rem 1rem;
        }

        .intake-header {
          text-align: center;
          max-width: 640px;
          margin: 0 auto 1.5rem;
        }

        .intake-title {
          font-size: 1.875rem;
          font-weight: 700;
          color: var(--color-primary, #1a365d);
          margin-bottom: 0.5rem;
        }

        .intake-subtitle {
          color: var(--color-text-light, #4a5568);
          font-size: 1rem;
        }

        .intake-card {
          max-width: 640px;
          margin: 0 auto;
          background: var(--color-bg, #ffffff);
          border-radius: 0.75rem;
          padding: 2rem;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        }

        .intake-step {
          min-height: 300px;
        }

        .intake-step-title {
          font-size: 1.25rem;
          font-weight: 700;
          color: var(--color-primary, #1a365d);
          margin-bottom: 0.75rem;
        }

        .intake-step-desc {
          color: var(--color-text-light, #4a5568);
          font-size: 0.9375rem;
          margin-bottom: 1.5rem;
        }

        .intake-field {
          margin-bottom: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }

        .intake-label {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--color-text, #1a202c);
        }

        .intake-required {
          color: var(--color-accent, #e53e3e);
        }

        .intake-hint {
          color: var(--color-text-light, #4a5568);
          font-size: 0.8125rem;
        }

        .intake-input,
        .intake-select,
        .intake-textarea {
          padding: 0.75rem;
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: 0.5rem;
          font-family: inherit;
          font-size: 0.9375rem;
          color: var(--color-text, #1a202c);
          background: var(--color-bg, #ffffff);
          width: 100%;
          transition: border-color 0.15s;
        }

        .intake-input:focus,
        .intake-select:focus,
        .intake-textarea:focus {
          outline: none;
          border-color: var(--color-primary, #1a365d);
          box-shadow: 0 0 0 3px rgba(26, 54, 93, 0.1);
        }

        .intake-textarea {
          resize: vertical;
          min-height: 80px;
        }

        .intake-error {
          color: var(--color-accent, #e53e3e);
          font-size: 0.8125rem;
          margin-top: 0.25rem;
        }

        .intake-faq-list {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }

        .intake-faq-item {
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
        }

        .intake-faq-num {
          min-width: 1.5rem;
          height: 1.5rem;
          border-radius: 50%;
          background: var(--color-bg-alt, #f7fafc);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--color-text-light);
          margin-top: 0.625rem;
          flex-shrink: 0;
        }

        .intake-faq-fields {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }

        .intake-faq-remove {
          color: var(--color-accent, #e53e3e);
          font-size: 1.25rem;
          font-weight: 700;
          padding: 0 0.25rem;
          margin-top: 0.375rem;
          flex-shrink: 0;
          cursor: pointer;
        }

        .intake-add-btn {
          background: transparent;
          color: var(--color-primary, #1a365d);
          border: 1px dashed var(--color-border, #e2e8f0);
          border-radius: 0.5rem;
          padding: 0.625rem 1rem;
          font-size: 0.875rem;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          width: 100%;
          transition: background-color 0.15s;
        }

        .intake-add-btn:hover {
          background: var(--color-bg-alt, #f7fafc);
        }

        .intake-channels {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-bottom: 1.5rem;
        }

        .intake-channel {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.875rem 1rem;
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: 0.5rem;
          cursor: pointer;
          transition: border-color 0.15s, background-color 0.15s;
        }

        .intake-channel.checked {
          border-color: var(--color-primary, #1a365d);
          background: rgba(26, 54, 93, 0.04);
        }

        .intake-channel-label {
          font-size: 0.9375rem;
          font-weight: 500;
          color: var(--color-text, #1a202c);
        }

        .intake-checkbox {
          width: 18px;
          height: 18px;
          accent-color: var(--color-primary, #1a365d);
          cursor: pointer;
        }

        .intake-tones,
        .intake-pronouns {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-top: 0.5rem;
        }

        .intake-tone-option {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.875rem 1rem;
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: 0.5rem;
          cursor: pointer;
          transition: border-color 0.15s;
        }

        .intake-tone-option:has(.intake-radio:checked) {
          border-color: var(--color-primary, #1a365d);
          background: rgba(26, 54, 93, 0.04);
        }

        .intake-tone-option span {
          font-weight: 500;
          font-size: 0.9375rem;
        }

        .intake-tone-option small {
          margin-left: auto;
          color: var(--color-text-light);
          font-size: 0.8125rem;
        }

        .intake-radio {
          width: 18px;
          height: 18px;
          accent-color: var(--color-primary, #1a365d);
          cursor: pointer;
        }

        .intake-languages {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-top: 0.5rem;
        }

        .intake-language {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.875rem 1rem;
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: 0.5rem;
          cursor: pointer;
          transition: border-color 0.15s, background-color 0.15s;
        }

        .intake-language.checked {
          border-color: var(--color-primary, #1a365d);
          background: rgba(26, 54, 93, 0.04);
        }

        .intake-language span {
          font-size: 0.9375rem;
          font-weight: 500;
          color: var(--color-text, #1a202c);
        }

        .intake-review {
          background: var(--color-bg-alt, #f7fafc);
          border-radius: 0.5rem;
          padding: 1.25rem;
          margin-top: 1.5rem;
          margin-bottom: 1.5rem;
        }

        .intake-review h3 {
          font-size: 1rem;
          font-weight: 600;
          color: var(--color-primary, #1a365d);
          margin-bottom: 1rem;
        }

        .intake-review-list {
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
        }

        .intake-review-row {
          display: flex;
          justify-content: space-between;
          font-size: 0.875rem;
        }

        .intake-review-row dt {
          color: var(--color-text-light, #4a5568);
        }

        .intake-review-row dd {
          font-weight: 500;
          color: var(--color-text, #1a202c);
        }

        .intake-nav {
          display: flex;
          justify-content: space-between;
          margin-top: 2rem;
          gap: 0.75rem;
        }

        .intake-btn {
          padding: 0.75rem 1.5rem;
          border-radius: 0.5rem;
          font-size: 0.9375rem;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: background-color 0.15s;
        }

        .intake-btn--primary {
          background: var(--color-primary, #1a365d);
          color: #ffffff;
          border: none;
          margin-left: auto;
        }

        .intake-btn--primary:hover {
          background: var(--color-primary-light, #2c5282);
        }

        .intake-btn--secondary {
          background: transparent;
          color: var(--color-text-light, #4a5568);
          border: 1px solid var(--color-border, #e2e8f0);
        }

        .intake-btn--secondary:hover {
          background: var(--color-bg-alt, #f7fafc);
        }

        .intake-btn--submit {
          background: var(--color-accent, #e53e3e);
          color: #ffffff;
          border: none;
          margin-left: auto;
        }

        .intake-btn--submit:hover:not(:disabled) {
          background: var(--color-accent-hover, #c53030);
        }

        .intake-btn--submit:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .intake-success {
          text-align: center;
          padding: 3rem 1rem;
        }

        .intake-success-icon {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: #48bb78;
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 2rem;
          font-weight: 700;
          margin: 0 auto 1.5rem;
        }

        .intake-success h2 {
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--color-text, #1a202c);
          margin-bottom: 0.75rem;
        }

        .intake-success p {
          color: var(--color-text-light, #4a5568);
          font-size: 1rem;
        }

        .intake-progress {
          margin-bottom: 2rem;
        }

        .intake-progress-track {
          height: 4px;
          background: var(--color-border, #e2e8f0);
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 1rem;
        }

        .intake-progress-fill {
          height: 100%;
          background: var(--color-primary, #1a365d);
          transition: width 0.3s ease;
          border-radius: 2px;
        }

        .intake-progress-steps {
          display: flex;
          justify-content: space-between;
        }

        .intake-progress-step {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.375rem;
        }

        .intake-progress-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--color-border, #e2e8f0);
          transition: background-color 0.2s;
        }

        .intake-progress-step.active .intake-progress-dot {
          background: var(--color-primary, #1a365d);
          width: 12px;
          height: 12px;
        }

        .intake-progress-step.done .intake-progress-dot {
          background: #48bb78;
        }

        .intake-summary-error {
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
          background: #fff5f5;
          border: 1px solid var(--color-accent, #e53e3e);
          border-left: 4px solid var(--color-accent, #e53e3e);
          color: #742a2a;
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          margin-bottom: 1.5rem;
          font-size: 0.9375rem;
          line-height: 1.4;
        }

        .intake-summary-error-icon {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: var(--color-accent, #e53e3e);
          color: #ffffff;
          font-weight: 700;
          font-size: 0.875rem;
        }

        .intake-summary-error-close {
          margin-left: auto;
          background: transparent;
          border: none;
          color: #742a2a;
          font-size: 1.25rem;
          font-weight: 700;
          cursor: pointer;
          line-height: 1;
          padding: 0 0.25rem;
        }

        .intake-input[aria-invalid="true"],
        .intake-select[aria-invalid="true"],
        .intake-textarea[aria-invalid="true"] {
          border-color: var(--color-accent, #e53e3e);
          background: #fff5f5;
        }

        .intake-input[aria-invalid="true"]:focus,
        .intake-select[aria-invalid="true"]:focus,
        .intake-textarea[aria-invalid="true"]:focus {
          box-shadow: 0 0 0 3px rgba(229, 62, 62, 0.18);
        }

        .intake-progress-label {
          font-size: 0.6875rem;
          color: var(--color-text-light, #4a5568);
          text-align: center;
          max-width: 60px;
          line-height: 1.2;
          display: none;
        }

        @media (min-width: 640px) {
          .intake-progress-label {
            display: block;
          }
        }

        @media (max-width: 480px) {
          .intake-card {
            padding: 1.25rem;
          }

          .intake-title {
            font-size: 1.5rem;
          }

          .intake-tone-option small {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}

export default IntakePage;
