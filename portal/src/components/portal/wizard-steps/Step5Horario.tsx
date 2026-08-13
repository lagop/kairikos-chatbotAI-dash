'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step5Schema, type Step5Input } from '@/lib/wizard-schemas';
import {
  HORARIO_DEFAULT_DIAS,
  HORARIO_DEFAULT_FIN,
  HORARIO_DEFAULT_INICIO,
  TIMEZONE_DEFAULT,
} from '@/lib/wizard-templates';
import { useZodValidation } from './useZodValidation';
import { Button, FieldRow, Select, Textarea, TextInput } from './primitives';
import { ChipToggleGroup, CompactRadioGroup } from '@/components/forms/CompactSelectionControls';

interface Props {
  value: Step5Input | null;
  onChange: (value: Step5Input) => void;
}

const TIMEZONES: { value: string; label: string }[] = [
  { value: 'Atlantic/Canary', label: 'Canarias (Atlantic/Canary)' },
  { value: 'Europe/Madrid', label: 'Península (Europe/Madrid)' },
  { value: 'Europe/Lisbon', label: 'Portugal (Europe/Lisbon)' },
  { value: 'Europe/Paris', label: 'Francia (Europe/Paris)' },
  { value: 'America/Mexico_City', label: 'México (America/Mexico_City)' },
  { value: 'America/Buenos_Aires', label: 'Argentina (America/Buenos_Aires)' },
  { value: 'America/Bogota', label: 'Colombia (America/Bogota)' },
];

const DIAS = [
  { value: 'lunes', label: 'L' },
  { value: 'martes', label: 'M' },
  { value: 'miercoles', label: 'X' },
  { value: 'jueves', label: 'J' },
  { value: 'viernes', label: 'V' },
  { value: 'sabado', label: 'S' },
  { value: 'domingo', label: 'D' },
];

const COMPORTAMIENTO_OPTIONS = [
  { value: 'solo_informa', label: 'Solo informa del horario' },
  { value: 'captura_lead', label: 'Captura datos de contacto' },
  { value: 'mensaje_personalizado', label: 'Mensaje personalizado' },
];

interface FranjaDraft {
  dias: string[];
  hora_inicio: string;
  hora_fin: string;
}

const emptyFranja: FranjaDraft = {
  dias: [...HORARIO_DEFAULT_DIAS],
  hora_inicio: HORARIO_DEFAULT_INICIO,
  hora_fin: HORARIO_DEFAULT_FIN,
};

function fromSaved(s: Record<string, unknown>): FranjaDraft {
  return {
    dias: Array.isArray(s.dias) ? (s.dias as string[]) : [],
    hora_inicio: String(s.hora_inicio ?? HORARIO_DEFAULT_INICIO),
    hora_fin: String(s.hora_fin ?? HORARIO_DEFAULT_FIN),
  };
}

export function Step5Horario({ value, onChange }: Props) {
  const step = getStep(5);
  const [timezone, setTimezone] = useState<string>(value?.timezone ?? TIMEZONE_DEFAULT);
  const [franjas, setFranjas] = useState<FranjaDraft[]>(
    (value?.horario ?? []).map((f) => fromSaved(f as Record<string, unknown>)),
  );
  const [comportamiento, setComportamiento] = useState<Step5Input['comportamiento_fuera_horario']>(
    value?.comportamiento_fuera_horario ?? 'solo_informa',
  );
  const [mensaje, setMensaje] = useState<string>(value?.mensaje_fuera_horario ?? '');

  const { errorMap } = useZodValidation(step5Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (tz: string, fr: FranjaDraft[], comp: Step5Input['comportamiento_fuera_horario'], msg: string) => {
    const payload: Step5Input = {
      timezone: tz,
      horario: fr.map((f) => ({ dias: f.dias, hora_inicio: f.hora_inicio, hora_fin: f.hora_fin })),
      comportamiento_fuera_horario: comp,
      mensaje_fuera_horario: msg,
    };
    const r = step5Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const onTimezoneChange = (v: string) => {
    setTimezone(v);
    emit(v, franjas, comportamiento, mensaje);
  };
  const onComportamientoChange = (v: string) => {
    const next = v as Step5Input['comportamiento_fuera_horario'];
    setComportamiento(next);
    emit(timezone, franjas, next, mensaje);
  };
  const onMensajeChange = (v: string) => {
    setMensaje(v);
    emit(timezone, franjas, comportamiento, v);
  };
  const updateFranja = (i: number, patch: Partial<FranjaDraft>) => {
    const next = franjas.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    setFranjas(next);
    emit(timezone, next, comportamiento, mensaje);
  };
  const addFranja = () => {
    const next = [...franjas, emptyFranja];
    setFranjas(next);
    emit(timezone, next, comportamiento, mensaje);
  };
  const removeFranja = (i: number) => {
    const next = franjas.filter((_, idx) => idx !== i);
    setFranjas(next);
    emit(timezone, next, comportamiento, mensaje);
  };

  return (
    <div className="space-y-5">
      <FieldRow
        label={step.fields.timezone.label}
        htmlFor="timezone"
        required
        helper={step.fields.timezone.helper}
        error={err('timezone')}
      >
        <Select
          id="timezone"
          name="timezone"
          value={timezone}
          onChange={onTimezoneChange}
          options={TIMEZONES}
        />
      </FieldRow>

      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.horario.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.horario.helper}
        </p>
        <div className="space-y-3">
          {franjas.map((f, i) => (
            <div
              key={i}
              className="space-y-3 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3"
            >
              <ChipToggleGroup
                legend={step.fields.horario.subfields.dias.label}
                name={`horario.${i}.dias`}
                options={DIAS}
                values={f.dias}
                onChange={(v) => updateFranja(i, { dias: v })}
              />
              <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
                <FieldRow
                  label={step.fields.horario.subfields.hora_inicio.label}
                  htmlFor={`horario-inicio-${i}`}
                  required
                  error={err(`horario.${i}.hora_inicio`)}
                >
                  <TextInput
                    id={`horario-inicio-${i}`}
                    name={`horario[${i}].hora_inicio`}
                    type="time"
                    value={f.hora_inicio}
                    onChange={(v) => updateFranja(i, { hora_inicio: v })}
                  />
                </FieldRow>
                <FieldRow
                  label={step.fields.horario.subfields.hora_fin.label}
                  htmlFor={`horario-fin-${i}`}
                  required
                  error={err(`horario.${i}.hora_fin`)}
                >
                  <TextInput
                    id={`horario-fin-${i}`}
                    name={`horario[${i}].hora_fin`}
                    type="time"
                    value={f.hora_fin}
                    onChange={(v) => updateFranja(i, { hora_fin: v })}
                  />
                </FieldRow>
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => removeFranja(i)}>
                  Quitar franja
                </Button>
              </div>
            </div>
          ))}
          {franjas.length === 0 ? (
            <p className="text-sm text-kairikos-muted">
              Añade al menos una franja horaria.
            </p>
          ) : null}
          <div>
            <Button variant="ghost" onClick={addFranja}>
              + {step.fields.horario.addSchedule}
            </Button>
          </div>
        </div>
        {err('horario') ? (
          <p role="alert" className="mt-2 text-xs text-kairikos-danger">
            {err('horario')}
          </p>
        ) : null}
      </div>

      <CompactRadioGroup
        legend={step.fields.comportamiento_fuera_horario.label}
        name="comportamiento_fuera_horario"
        options={COMPORTAMIENTO_OPTIONS}
        value={comportamiento}
        onChange={onComportamientoChange}
        error={err('comportamiento_fuera_horario')}
      />

      {comportamiento === 'mensaje_personalizado' ? (
        <FieldRow
          label={step.fields.mensaje_fuera_horario.label}
          htmlFor="mensaje_fuera_horario"
          required
          helper={step.fields.mensaje_fuera_horario.helper}
          error={err('mensaje_fuera_horario')}
        >
          <Textarea
            id="mensaje_fuera_horario"
            name="mensaje_fuera_horario"
            value={mensaje}
            onChange={onMensajeChange}
            placeholder={step.fields.mensaje_fuera_horario.placeholder}
            maxLength={300}
            rows={3}
          />
        </FieldRow>
      ) : null}
    </div>
  );
}
