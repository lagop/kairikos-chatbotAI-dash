"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm, useFieldArray, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  intakeSchema,
  type IntakeFormData,
  STEPS,
  SECTOR_LABELS,
  SECTORS,
  CHANNEL_OPTIONS,
  TONE_OPTIONS,
  TIMEZONES,
  STORAGE_KEY,
  type Sector,
} from "@/lib/intake-schema";

const DAY_LABELS: Record<string, string> = {
  monday: "Lunes",
  tuesday: "Martes",
  wednesday: "Miércoles",
  thursday: "Jueves",
  friday: "Viernes",
  saturday: "Sábado",
  sunday: "Domingo",
};

const defaultSchedule = {
  monday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
  tuesday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
  wednesday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
  thursday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
  friday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
  saturday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
  sunday: { enabled: false, openAM: "", closeAM: "", openPM: "", closePM: "" },
};

const defaultValues: IntakeFormData = {
  business_name: "",
  legal_name: "",
  sector: "abogado",
  faqs: Array.from({ length: 10 }, () => ({ question: "", answer: "" })),
  channels: ["web_chat"],
  whatsapp_number: "",
  instagram_handle: "",
  tone: "formal",
  timezone: "Europe/Madrid",
  schedule: defaultSchedule,
  billing_email: "",
  billing_name: "",
  billing_nif: "",
  billing_address: "",
  rgpd_consent: true,
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
  const watchedChannels = useWatch({ control, name: "channels" });

  useEffect(() => {
    const timeout = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(getValues()));
      } catch {}
    }, 800);
    return () => clearTimeout(timeout);
  }, [watchedSector, getValues]);

  const goNext = useCallback(async () => {
    const stepFields: (keyof IntakeFormData)[] = [
      "business_name",
      "faqs",
      "channels",
      "tone",
      "timezone",
      "billing_email",
    ];
    const fieldsToValidate = Array.isArray(stepFields[currentStep])
      ? stepFields[currentStep]
      : [stepFields[currentStep]];
    const valid = await trigger(fieldsToValidate as (keyof IntakeFormData)[]);
    if (!valid) return;
    trackEvent("intake_step_complete", { step: currentStep + 1 });
    setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [currentStep, trigger]);

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

      <div className="intake-card">
        <ProgressBar steps={STEPS} currentStep={currentStep} />

        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          {/* P1 — Identidad del negocio */}
          {currentStep === 0 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Identidad del negocio</h2>
              <StepField label="Nombre del negocio" required error={errors.business_name?.message}>
                <input
                  id="business_name"
                  type="text"
                  className="intake-input"
                  placeholder="Ej: Despacho García & Asociados"
                  {...register("business_name")}
                  aria-required="true"
                />
              </StepField>
              <StepField label="Nombre legal (opcional)" error={errors.legal_name?.message}>
                <input
                  id="legal_name"
                  type="text"
                  className="intake-input"
                  placeholder="Ej: García López S.L.P."
                  {...register("legal_name")}
                />
              </StepField>
              <StepField label="Sector" required error={errors.sector?.message}>
                <select
                  id="sector"
                  className="intake-select"
                  {...register("sector")}
                  aria-required="true"
                >
                  <option value="">Selecciona tu sector</option>
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>
                      {SECTOR_LABELS[s as Sector]}
                    </option>
                  ))}
                </select>
              </StepField>
            </div>
          )}

          {/* P2 — FAQs del sector */}
          {currentStep === 1 && (
            <div className="intake-step">
              <h2 className="intake-step-title">FAQs del sector</h2>
              <p className="intake-step-desc">
                Añade las preguntas más frecuentes de tus clientes. Mínimo 10, máximo 50.
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
                        {...register(`faqs.${i}.question` as const)}
                        aria-label={`Pregunta ${i + 1}`}
                      />
                      <textarea
                        className="intake-input intake-textarea"
                        placeholder="Respuesta"
                        rows={2}
                        {...register(`faqs.${i}.answer` as const)}
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
              {faqFields.length < 50 && (
                <button
                  type="button"
                  className="intake-add-btn"
                  onClick={() => append({ question: "", answer: "" })}
                >
                  + Añadir pregunta
                </button>
              )}
              {errors.faqs && typeof errors.faqs.message === "string" && (
                <p className="intake-error" role="alert">{errors.faqs.message}</p>
              )}
            </div>
          )}

          {/* P3 — Canales */}
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
                        {...register("channels")}
                        className="intake-checkbox"
                      />
                      <span className="intake-channel-label">
                        {ch === "web_chat" ? "Chat en tu web" : ch === "whatsapp" ? "WhatsApp" : "Instagram"}
                      </span>
                    </label>
                  );
                })}
              </div>
              {errors.channels && (
                <p className="intake-error" role="alert">{errors.channels.message}</p>
              )}

              {watchedChannels?.includes("whatsapp") && (
                <StepField label="Número de WhatsApp" error={errors.whatsapp_number?.message}>
                  <input
                    type="tel"
                    className="intake-input"
                    placeholder="+34 600 000 000"
                    {...register("whatsapp_number")}
                  />
                </StepField>
              )}
              {watchedChannels?.includes("instagram") && (
                <StepField label="Usuario de Instagram" error={errors.instagram_handle?.message}>
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

          {/* P4 — Tono y estilo */}
          {currentStep === 3 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Tono y estilo</h2>
              <p className="intake-step-desc">
                ¿Cómo quieres que se comunique tu chatbot con los clientes?
              </p>
              <div className="intake-tones">
                {TONE_OPTIONS.map((tone) => (
                  <label key={tone} className="intake-tone-option">
                    <input
                      type="radio"
                      value={tone}
                      {...register("tone")}
                      className="intake-radio"
                    />
                    <span>
                      {tone === "formal"
                        ? "Formal"
                        : tone === "semiformal"
                        ? "Semi-formal"
                        : tone === "casual"
                        ? "Casual"
                        : "Amigable"}
                    </span>
                    <small>
                      {tone === "formal"
                        ? "Lenguaje profesional y respetuoso"
                        : tone === "semiformal"
                        ? "Profesional pero cercano"
                        : tone === "casual"
                        ? "Desenfadado y directo"
                        : "Cálido y cercano"}
                    </small>
                  </label>
                ))}
              </div>
              {errors.tone && (
                <p className="intake-error" role="alert">{errors.tone.message}</p>
              )}
            </div>
          )}

          {/* P5 — Horario operativo */}
          {currentStep === 4 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Horario operativo</h2>
              <StepField label="Zona horaria" required error={errors.timezone?.message}>
                <select
                  id="timezone"
                  className="intake-select"
                  {...register("timezone")}
                  aria-required="true"
                >
                  <option value="">Selecciona zona horaria</option>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </StepField>
              <div className="intake-schedule">
                {/* Monday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.monday.enabled" as any)} />
                    <span>Lunes</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.monday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.monday.closeAM" as any)} />
                  </div>
                </div>
                {/* Tuesday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.tuesday.enabled" as any)} />
                    <span>Martes</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.tuesday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.tuesday.closeAM" as any)} />
                  </div>
                </div>
                {/* Wednesday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.wednesday.enabled" as any)} />
                    <span>Miércoles</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.wednesday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.wednesday.closeAM" as any)} />
                  </div>
                </div>
                {/* Thursday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.thursday.enabled" as any)} />
                    <span>Jueves</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.thursday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.thursday.closeAM" as any)} />
                  </div>
                </div>
                {/* Friday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.friday.enabled" as any)} />
                    <span>Viernes</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.friday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.friday.closeAM" as any)} />
                  </div>
                </div>
                {/* Saturday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.saturday.enabled" as any)} />
                    <span>Sábado</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.saturday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.saturday.closeAM" as any)} />
                  </div>
                </div>
                {/* Sunday */}
                <div className="intake-day-row">
                  <label className="intake-day-toggle">
                    <input type="checkbox" {...register("schedule.sunday.enabled" as any)} />
                    <span>Domingo</span>
                  </label>
                  <div className="intake-day-hours">
                    <input type="time" className="intake-input intake-time" placeholder="Abre" {...register("schedule.sunday.openAM" as any)} />
                    <span>–</span>
                    <input type="time" className="intake-input intake-time" placeholder="Cierra" {...register("schedule.sunday.closeAM" as any)} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* P6 — Datos de facturación */}
          {currentStep === 5 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Datos de facturación</h2>
              <StepField label="Correo electrónico de facturación" required error={errors.billing_email?.message}>
                <input
                  type="email"
                  className="intake-input"
                  placeholder="facturas@tuempresa.com"
                  {...register("billing_email")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goNext();
                    }
                  }}
                  aria-required="true"
                />
              </StepField>
              <StepField label="Nombre fiscal" required error={errors.billing_name?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="Nombre tal como aparece en facturas"
                  {...register("billing_name")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goNext();
                    }
                  }}
                  aria-required="true"
                />
              </StepField>
              <StepField label="NIF / CIF (opcional)" error={errors.billing_nif?.message}>
                <input
                  type="text"
                  className="intake-input"
                  placeholder="B12345678"
                  {...register("billing_nif")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goNext();
                    }
                  }}
                />
              </StepField>
              <StepField label="Dirección fiscal" required error={errors.billing_address?.message}>
                <textarea
                  className="intake-input intake-textarea"
                  placeholder="Calle, número, código postal, ciudad"
                  rows={3}
                  {...register("billing_address")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      goNext();
                    }
                  }}
                  aria-required="true"
                />
              </StepField>
            </div>
          )}

          {/* P7 — Confirmación + RGPD */}
          {currentStep === 6 && (
            <div className="intake-step">
              <h2 className="intake-step-title">Confirmación</h2>
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
                    <dd>{getValues("faqs").filter((f) => f.question).length}</dd>
                  </div>
                  <div className="intake-review-row">
                    <dt>Canales</dt>
                    <dd>{getValues("channels").join(", ")}</dd>
                  </div>
                  <div className="intake-review-row">
                    <dt>Tono</dt>
                    <dd>{getValues("tone")}</dd>
                  </div>
                </dl>
              </div>
              <label className="intake-rgpd">
                <input
                  type="checkbox"
                  {...register("rgpd_consent")}
                  className="intake-checkbox"
                  aria-required="true"
                />
                <span>
                  He leído y acepto la{" "}
                  <a href="/politica-privacidad" target="_blank" rel="noopener">
                    política de privacidad
                  </a>{" "}
                  y consiento el tratamiento de mis datos para la prestación del servicio.
                </span>
              </label>
              {errors.rgpd_consent && (
                <p className="intake-error" role="alert">{errors.rgpd_consent.message}</p>
              )}
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

        .intake-tones {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
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

        .intake-schedule {
          margin-top: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .intake-day-row {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 0.5rem 0;
          border-bottom: 1px solid var(--color-border, #e2e8f0);
        }

        .intake-day-toggle {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          min-width: 120px;
          cursor: pointer;
          font-size: 0.9375rem;
        }

        .intake-day-hours {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-left: auto;
        }

        .intake-time {
          width: 110px;
        }

        .intake-review {
          background: var(--color-bg-alt, #f7fafc);
          border-radius: 0.5rem;
          padding: 1.25rem;
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

        .intake-rgpd {
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
          font-size: 0.875rem;
          color: var(--color-text, #1a202c);
          cursor: pointer;
          line-height: 1.5;
        }

        .intake-rgpd a {
          color: var(--color-primary, #1a365d);
          text-decoration: underline;
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

        /* Progress Bar */
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

          .intake-day-row {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.5rem;
          }

          .intake-day-hours {
            margin-left: 0;
          }
        }
      `}</style>
    </div>
  );
}

export default IntakePage;
