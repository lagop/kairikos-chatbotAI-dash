'use client';

import { useState, useEffect } from 'react';
import { getStep } from '@/messages/wizard-es';
import {
  step6Schema,
  type Step6Input,
  COMPLIANCE_TEMPLATES,
} from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import {
  CheckboxGroup,
  FieldRow,
  RadioGroup,
  Textarea,
  TextInput,
  Toggle,
  Button,
} from './primitives';

interface Props {
  value: Step6Input | null;
  vertical: string | null;
  step10Consentimiento: string | null;
  onChange: (value: Step6Input) => void;
}

const DATOS_OPTIONS = [
  { value: 'nombre', label: 'Nombre' },
  { value: 'telefono', label: 'Teléfono' },
  { value: 'email', label: 'Email' },
  { value: 'motivo', label: 'Motivo de la consulta' },
];

const MOMENTO_OPTIONS = [
  { value: 'al_inicio', label: 'Al inicio' },
  { value: 'antes_de_derivar', label: 'Antes de derivar' },
  { value: 'a_peticion', label: 'Cuando el cliente lo pida' },
];

const PLANTILLA_BY_VERTICAL = (vertical: string | null) => {
  if (vertical && COMPLIANCE_TEMPLATES[vertical]) return COMPLIANCE_TEMPLATES[vertical].plantilla_base;
  return COMPLIANCE_TEMPLATES.default.plantilla_base;
};

export function Step6Captacion({
  value,
  vertical,
  step10Consentimiento,
  onChange,
}: Props) {
  const step = getStep(6);
  const defaultConsentimiento = step10Consentimiento ?? PLANTILLA_BY_VERTICAL(vertical);
  const wasOverridden =
    !!value?.texto_consentimiento &&
    value.texto_consentimiento !== defaultConsentimiento &&
    value.texto_consentimiento !== (step10Consentimiento ?? '');

  const [datos, setDatos] = useState<string[]>(value?.datos_solicitados ?? ['nombre', 'email']);
  const [camposExtra, setCamposExtra] = useState<string[]>(value?.campos_extra ?? []);
  const [momento, setMomento] = useState<Step6Input['momento_captura']>(
    value?.momento_captura ?? 'antes_de_derivar',
  );
  const [email, setEmail] = useState<string>(value?.email_notificacion ?? '');
  const [consentimiento, setConsentimiento] = useState<string>(value?.texto_consentimiento ?? defaultConsentimiento);
  const [override, setOverride] = useState<boolean>(wasOverridden);

  // Re-seed consentimiento when Step 10 changes (or on mount) if not overridden.
  useEffect(() => {
    if (!override) {
      setConsentimiento(step10Consentimiento ?? PLANTILLA_BY_VERTICAL(vertical));
    }
  }, [step10Consentimiento, vertical, override]);

  const { errorMap } = useZodValidation(step6Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (
    d: string[],
    ce: string[],
    m: Step6Input['momento_captura'],
    e: string,
    c: string,
  ) => {
    const payload: Step6Input = {
      datos_solicitados: d as Step6Input['datos_solicitados'],
      campos_extra: ce,
      momento_captura: m,
      destino_lead: 'email',
      email_notificacion: e,
      texto_consentimiento: c,
    };
    const r = step6Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const onDatosChange = (v: string[]) => {
    setDatos(v);
    emit(v, camposExtra, momento, email, consentimiento);
  };
  const onCamposChange = (v: string) => {
    const arr = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setCamposExtra(arr);
    emit(datos, arr, momento, email, consentimiento);
  };
  const onCamposAdd = () => {
    const arr = [...camposExtra, ''];
    setCamposExtra(arr);
    emit(datos, arr, momento, email, consentimiento);
  };
  const onCamposRemove = (i: number) => {
    const arr = camposExtra.filter((_, idx) => idx !== i);
    setCamposExtra(arr);
    emit(datos, arr, momento, email, consentimiento);
  };
  const onCamposUpdate = (i: number, v: string) => {
    const arr = camposExtra.map((c, idx) => (idx === i ? v : c));
    setCamposExtra(arr);
    emit(datos, arr, momento, email, consentimiento);
  };
  const onMomentoChange = (v: string) => {
    const next = v as Step6Input['momento_captura'];
    setMomento(next);
    emit(datos, camposExtra, next, email, consentimiento);
  };
  const onEmailChange = (v: string) => {
    setEmail(v);
    emit(datos, camposExtra, momento, v, consentimiento);
  };
  const onConsentChange = (v: string) => {
    setConsentimiento(v);
    emit(datos, camposExtra, momento, email, v);
  };
  const onOverrideChange = (v: boolean) => {
    setOverride(v);
    if (!v) {
      // Reset to Step 10 value
      const reset = step10Consentimiento ?? PLANTILLA_BY_VERTICAL(vertical);
      setConsentimiento(reset);
      emit(datos, camposExtra, momento, email, reset);
    }
  };

  return (
    <div className="space-y-5">
      <FieldRow
        label={step.fields.datos_solicitados.label}
        required
        helper={step.fields.datos_solicitados.helper}
        error={err('datos_solicitados')}
      >
        <CheckboxGroup
          legend={step.fields.datos_solicitados.label}
          name="datos_solicitados"
          options={DATOS_OPTIONS}
          values={datos}
          onChange={onDatosChange}
        />
      </FieldRow>

      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.campos_extra.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.campos_extra.helper}
        </p>
        <div className="space-y-2">
          {camposExtra.map((c, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row">
              <TextInput
                id={`campos-extra-${i}`}
                name={`campos_extra[${i}]`}
                value={c}
                onChange={(v) => onCamposUpdate(i, v)}
                placeholder={step.fields.campos_extra.placeholder}
                maxLength={80}
              />
              <Button variant="ghost" onClick={() => onCamposRemove(i)}>
                Quitar
              </Button>
            </div>
          ))}
          <Button variant="ghost" onClick={onCamposAdd}>
            + {step.fields.campos_extra.addField}
          </Button>
          <p className="text-xs text-kairikos-muted">
            También puedes escribirlos separados por comas:
          </p>
          <TextInput
            id="campos_extra_csv"
            name="campos_extra_csv"
            value={camposExtra.join(', ')}
            onChange={onCamposChange}
            placeholder="Ej.: zona, urgencia"
          />
        </div>
      </div>

      <RadioGroup
        legend={step.fields.momento_captura.label}
        name="momento_captura"
        options={MOMENTO_OPTIONS}
        value={momento}
        onChange={onMomentoChange}
        error={err('momento_captura')}
      />

      <FieldRow
        label={step.fields.email_notificacion.label}
        htmlFor="email_notificacion"
        required
        helper={step.fields.email_notificacion.helper}
        error={err('email_notificacion')}
      >
        <TextInput
          id="email_notificacion"
          name="email_notificacion"
          type="email"
          inputMode="email"
          value={email}
          onChange={onEmailChange}
          placeholder={step.fields.email_notificacion.placeholder}
        />
      </FieldRow>

      <div className="space-y-3 rounded-xl border border-kairikos-accent/20 bg-kairikos-accent/5 p-4">
        <Toggle
          id="consent_override"
          name="consent_override"
          checked={override}
          onChange={onOverrideChange}
          label={step.fields.texto_consentimiento.override ?? 'Sobrescribir el texto que viene del Paso 10'}
          helper="Si lo desactivas, vuelve al texto del Paso 10 (cumplimiento)."
        />
        <FieldRow
          label={step.fields.texto_consentimiento.label}
          htmlFor="texto_consentimiento"
          required
          helper={
            override
              ? 'Estás usando tu propia versión. El Paso 10 sigue siendo la fuente canónica de cumplimiento.'
              : 'Pre-rellenado desde el Paso 10. Edita para divergir.'
          }
          error={err('texto_consentimiento')}
        >
          <Textarea
            id="texto_consentimiento"
            name="texto_consentimiento"
            value={consentimiento}
            onChange={onConsentChange}
            placeholder="Texto que verá y aceptará el cliente en el momento de la captación"
            maxLength={2000}
            rows={4}
            aria-invalid={!!err('texto_consentimiento')}
          />
        </FieldRow>
      </div>
    </div>
  );
}
