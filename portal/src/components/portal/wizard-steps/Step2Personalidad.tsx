'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step2Schema, type Step2Input } from '@/lib/wizard-schemas';
import {
  DISCLAIMER_BY_VERTICAL,
  TEMAS_PROHIBIDOS_BY_VERTICAL,
  TEMAS_PROHIBIDOS_LABELS,
} from '@/lib/wizard-templates';
import { useZodValidation } from './useZodValidation';
import {
  Button,
  CheckboxGroup,
  FieldRow,
  RadioGroup,
  Textarea,
} from './primitives';

interface Props {
  value: Step2Input | null;
  vertical: string | null;
  onChange: (value: Step2Input) => void;
}

const TONO_OPTIONS = [
  { value: 'formal', label: 'Formal' },
  { value: 'cercano', label: 'Cercano' },
];
const TRATAMIENTO_OPTIONS = [
  { value: 'tu', label: 'Tú' },
  { value: 'usted', label: 'Usted' },
];

export function Step2Personalidad({ value, vertical, onChange }: Props) {
  const step = getStep(2);
  const safeVertical = vertical && TEMAS_PROHIBIDOS_BY_VERTICAL[vertical] ? vertical : 'otro';
  const defaultChecklist = TEMAS_PROHIBIDOS_BY_VERTICAL[safeVertical] ?? [];
  const defaultDisclaimer = DISCLAIMER_BY_VERTICAL[safeVertical] ?? '';

  const [data, setData] = useState<Step2Input>(
    value ?? {
      tono: 'cercano',
      tratamiento: 'usted',
      ejemplos_respuesta: [],
      temas_prohibidos: { checklist: defaultChecklist, libre: '' },
      disclaimer: '',
    },
  );

  const { errorMap } = useZodValidation(step2Schema);

  const set = (patch: Partial<Step2Input>) => {
    const next = { ...data, ...patch } as Step2Input;
    setData(next);
    const r = step2Schema.safeParse(next);
    if (r.success) onChange(r.data);
  };

  const err = (path: string) => errorMap.get(path);
  const tpsOptions = defaultChecklist.map((k) => ({
    value: k,
    label: TEMAS_PROHIBIDOS_LABELS[k] ?? k,
  }));

  const updateEjemplo = (idx: number, texto: string) => {
    const next = [...(data.ejemplos_respuesta ?? [])];
    next[idx] = { texto };
    set({ ejemplos_respuesta: next });
  };
  const addEjemplo = () => {
    const next = [...(data.ejemplos_respuesta ?? [])];
    if (next.length >= 3) return;
    next.push({ texto: '' });
    set({ ejemplos_respuesta: next });
  };
  const removeEjemplo = (idx: number) => {
    const next = (data.ejemplos_respuesta ?? []).filter((_, i) => i !== idx);
    set({ ejemplos_respuesta: next });
  };

  return (
    <div className="space-y-5">
      <RadioGroup
        legend={step.fields.tono.label}
        name="tono"
        options={TONO_OPTIONS}
        value={data.tono}
        onChange={(v) => set({ tono: v as Step2Input['tono'] })}
        error={err('tono')}
      />

      <RadioGroup
        legend={step.fields.tratamiento.label}
        name="tratamiento"
        options={TRATAMIENTO_OPTIONS}
        value={data.tratamiento}
        onChange={(v) => set({ tratamiento: v as Step2Input['tratamiento'] })}
        error={err('tratamiento')}
      />

      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.ejemplos_respuesta.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.ejemplos_respuesta.helper}
        </p>
        <div className="space-y-2">
          {(data.ejemplos_respuesta ?? []).map((ej, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row">
              <Textarea
                id={`ejemplo-${i}`}
                name={`ejemplos_respuesta[${i}].texto`}
                value={ej.texto}
                onChange={(v) => updateEjemplo(i, v)}
                placeholder={step.fields.ejemplos_respuesta.placeholder}
                maxLength={300}
              />
              <Button variant="ghost" onClick={() => removeEjemplo(i)}>
                Quitar
              </Button>
            </div>
          ))}
          {(data.ejemplos_respuesta ?? []).length < 3 ? (
            <Button variant="ghost" onClick={addEjemplo}>
              + {step.fields.ejemplos_respuesta.addLabel}
            </Button>
          ) : null}
        </div>
        {err('ejemplos_respuesta') ? (
          <p role="alert" className="mt-1 text-xs text-kairikos-danger">
            {err('ejemplos_respuesta')}
          </p>
        ) : null}
      </div>

      <FieldRow
        label={step.fields.temas_prohibidos.label}
        helper={step.fields.temas_prohibidos.helperText}
        error={err('temas_prohibidos.checklist')}
      >
        <CheckboxGroup
          legend={step.fields.temas_prohibidos.label}
          name="temas_prohibidos.checklist"
          options={tpsOptions}
          values={data.temas_prohibidos.checklist}
          onChange={(v) =>
            set({
              temas_prohibidos: {
                ...data.temas_prohibidos,
                checklist: v,
              },
            })
          }
        />
        <Textarea
          id="temas_prohibidos.libre"
          name="temas_prohibidos.libre"
          value={data.temas_prohibidos.libre ?? ''}
          onChange={(v) =>
            set({ temas_prohibidos: { ...data.temas_prohibidos, libre: v } })
          }
          placeholder="Añade aquí cualquier tema adicional que el bot deba evitar (opcional)"
          rows={2}
          maxLength={500}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.disclaimer.label}
        htmlFor="disclaimer"
        helper={step.fields.disclaimer.helper}
        error={err('disclaimer')}
      >
        <Textarea
          id="disclaimer"
          name="disclaimer"
          value={data.disclaimer ?? defaultDisclaimer}
          onChange={(v) => set({ disclaimer: v })}
          placeholder={step.fields.disclaimer.placeholder}
          maxLength={300}
          rows={3}
        />
        <p className="mt-1 text-xs text-kairikos-muted">
          Sugerencia: <span className="italic">{defaultDisclaimer}</span>
        </p>
      </FieldRow>
    </div>
  );
}
