'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step1Schema, type Step1Input } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import {
  CheckboxGroup,
  FieldRow,
  Select,
  TextInput,
} from './primitives';

interface Props {
  value: Step1Input | null;
  onChange: (value: Step1Input) => void;
}

const VERTICALS: { value: string; label: string }[] = [
  { value: 'abogado', label: 'Abogado' },
  { value: 'clinica', label: 'Clínica' },
  { value: 'inmobiliaria', label: 'Inmobiliaria' },
  { value: 'gestoria', label: 'Gestoría' },
  { value: 'otro', label: 'Otro' },
];

const IDIOMAS: { value: string; label: string }[] = [
  { value: 'ES', label: 'Español' },
  { value: 'EN', label: 'Inglés' },
  { value: 'DE', label: 'Alemán' },
];

export function Step1Perfil({ value, onChange }: Props) {
  const step = getStep(1);
  const [data, setData] = useState<Step1Input>(
    value ?? {
      vertical: 'otro',
      nombre_comercial: '',
      razon_social: '',
      web: '',
      idiomas: ['ES'],
      idioma_por_defecto: 'ES',
    },
  );

  const { errorMap } = useZodValidation(step1Schema);

  const set = (patch: Partial<Step1Input>) => {
    const next = { ...data, ...patch } as Step1Input;
    setData(next);
    const r = step1Schema.safeParse(next);
    if (r.success) onChange(r.data);
  };

  const showError = (path: string) => errorMap.get(path);

  return (
    <div className="space-y-5">
      <FieldRow
        label={step.fields.vertical.label}
        htmlFor="vertical"
        required
        helper={step.fields.vertical.helper}
        error={showError('vertical')}
      >
        <Select
          id="vertical"
          name="vertical"
          value={data.vertical}
          onChange={(v) =>
            set({ vertical: v as Step1Input['vertical'] })
          }
          options={VERTICALS}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.nombre_comercial.label}
        htmlFor="nombre_comercial"
        required
        helper={step.fields.nombre_comercial.helper}
        error={showError('nombre_comercial')}
      >
        <TextInput
          id="nombre_comercial"
          name="nombre_comercial"
          value={data.nombre_comercial}
          onChange={(v) => set({ nombre_comercial: v })}
          placeholder={step.fields.nombre_comercial.placeholder}
          maxLength={80}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.razon_social.label}
        htmlFor="razon_social"
        helper={step.fields.razon_social.helper}
        error={showError('razon_social')}
      >
        <TextInput
          id="razon_social"
          name="razon_social"
          value={data.razon_social ?? ''}
          onChange={(v) => set({ razon_social: v })}
          placeholder={step.fields.razon_social.placeholder}
          maxLength={120}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.web.label}
        htmlFor="web"
        helper={step.fields.web.helper}
        error={showError('web')}
      >
        <TextInput
          id="web"
          name="web"
          type="url"
          inputMode="url"
          autoComplete="url"
          value={data.web ?? ''}
          onChange={(v) => set({ web: v })}
          placeholder={step.fields.web.placeholder}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.idiomas.label}
        required
        helper={step.fields.idiomas.helper}
        error={showError('idiomas')}
      >
        <CheckboxGroup
          legend={step.fields.idiomas.label}
          name="idiomas"
          options={IDIOMAS}
          values={data.idiomas}
          onChange={(v) => {
            const safe = v.includes('ES') ? v : ['ES', ...v];
            const nextDef = data.idioma_por_defecto;
            const def = safe.includes(nextDef) ? nextDef : (safe[0] ?? 'ES');
            set({ idiomas: safe as Step1Input['idiomas'], idioma_por_defecto: def });
          }}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.idioma_por_defecto.label}
        required
        helper={step.fields.idioma_por_defecto.helper}
        error={showError('idioma_por_defecto')}
      >
        <Select
          id="idioma_por_defecto"
          name="idioma_por_defecto"
          value={data.idioma_por_defecto}
          onChange={(v) => set({ idioma_por_defecto: v })}
          options={data.idiomas.map((i) => ({ value: i, label: IDIOMAS.find((x) => x.value === i)?.label ?? i }))}
        />
      </FieldRow>

    </div>
  );
}
