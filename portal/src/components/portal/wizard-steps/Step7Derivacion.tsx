'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step7Schema, type Step7Input } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import { Button, FieldRow, RadioGroup, Select, TextInput } from './primitives';

interface Props {
  value: Step7Input | null;
  onChange: (value: Step7Input) => void;
}

const FALLBACK_OPTIONS = [
  { value: 'derivar', label: 'Derivar a una persona' },
  { value: 'pedir_reformular', label: 'Pedir que reformule' },
  { value: 'capturar_lead', label: 'Capturar datos' },
];

const CONDICION_OPTIONS = [
  { value: 'tema_prohibido', label: 'Tema prohibido' },
  { value: 'palabra_clave', label: 'Palabra clave' },
  { value: 'fuera_horario', label: 'Fuera de horario' },
  { value: 'peticion_explicita', label: 'Petición explícita' },
];

const ACCION_OPTIONS = [
  { value: 'derivar_humano', label: 'Derivar a una persona' },
  { value: 'capturar_lead', label: 'Capturar datos' },
  { value: 'mensaje_fijo', label: 'Mensaje fijo' },
];

interface ReglaDraft {
  condicion_tipo: 'tema_prohibido' | 'palabra_clave' | 'fuera_horario' | 'peticion_explicita';
  valor: string;
  accion: 'derivar_humano' | 'capturar_lead' | 'mensaje_fijo';
  destino: string;
}

const emptyRegla: ReglaDraft = {
  condicion_tipo: 'palabra_clave',
  valor: '',
  accion: 'derivar_humano',
  destino: '',
};

function fromSaved(s: Record<string, unknown>): ReglaDraft {
  return {
    condicion_tipo:
      (s.condicion_tipo as ReglaDraft['condicion_tipo']) ?? 'palabra_clave',
    valor: Array.isArray(s.valor) ? s.valor.join(', ') : String(s.valor ?? ''),
    accion: (s.accion as ReglaDraft['accion']) ?? 'derivar_humano',
    destino: String(s.destino ?? ''),
  };
}

type ReglaOutput = {
  condicion_tipo: ReglaDraft['condicion_tipo'];
  accion: ReglaDraft['accion'];
  valor?: string | string[];
  destino?: string;
};

function toRegla(d: ReglaDraft): ReglaOutput {
  const base: ReglaOutput = {
    condicion_tipo: d.condicion_tipo,
    accion: d.accion,
  };
  if (d.condicion_tipo === 'palabra_clave') {
    base.valor = d.valor
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (d.condicion_tipo === 'tema_prohibido') {
    base.valor = d.valor.trim();
  }
  if (d.accion === 'derivar_humano') base.destino = d.destino.trim();
  return base;
}

export function Step7Derivacion({ value, onChange }: Props) {
  const step = getStep(7);
  const [reglas, setReglas] = useState<ReglaDraft[]>(
    (value?.reglas ?? []).map((r) => fromSaved(r as Record<string, unknown>)),
  );
  const [fallback, setFallback] = useState<Step7Input['fallback_sin_respuesta']>(
    value?.fallback_sin_respuesta ?? 'derivar',
  );

  const { errorMap } = useZodValidation(step7Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (r: ReglaDraft[], f: Step7Input['fallback_sin_respuesta']) => {
    const payload: Step7Input = { reglas: r.map(toRegla), fallback_sin_respuesta: f };
    const r2 = step7Schema.safeParse(payload);
    if (r2.success) onChange(r2.data);
  };

  const update = (i: number, patch: Partial<ReglaDraft>) => {
    const next = reglas.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setReglas(next);
    emit(next, fallback);
  };
  const add = () => {
    const next = [...reglas, emptyRegla];
    setReglas(next);
    emit(next, fallback);
  };
  const remove = (i: number) => {
    const next = reglas.filter((_, idx) => idx !== i);
    setReglas(next);
    emit(next, fallback);
  };
  const onFallbackChange = (v: string) => {
    const next = v as Step7Input['fallback_sin_respuesta'];
    setFallback(next);
    emit(reglas, next);
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.reglas.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.reglas.helper}
        </p>
        <div className="space-y-3">
          {reglas.map((r, i) => (
            <div
              key={i}
              className="space-y-3 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldRow
                  label={step.fields.reglas.subfields.condicion_tipo.label}
                  htmlFor={`regla-condicion-${i}`}
                  required
                  error={err(`reglas.${i}.condicion_tipo`)}
                >
                  <Select
                    id={`regla-condicion-${i}`}
                    name={`reglas[${i}].condicion_tipo`}
                    value={r.condicion_tipo}
                    onChange={(v) => update(i, { condicion_tipo: v as ReglaDraft['condicion_tipo'] })}
                    options={CONDICION_OPTIONS}
                  />
                </FieldRow>
                <FieldRow
                  label={step.fields.reglas.subfields.accion.label}
                  htmlFor={`regla-accion-${i}`}
                  required
                  error={err(`reglas.${i}.accion`)}
                >
                  <Select
                    id={`regla-accion-${i}`}
                    name={`reglas[${i}].accion`}
                    value={r.accion}
                    onChange={(v) => update(i, { accion: v as ReglaDraft['accion'] })}
                    options={ACCION_OPTIONS}
                  />
                </FieldRow>
              </div>
              {r.condicion_tipo !== 'fuera_horario' && r.condicion_tipo !== 'peticion_explicita' ? (
                <FieldRow
                  label={step.fields.reglas.subfields.valor.label}
                  htmlFor={`regla-valor-${i}`}
                  required={r.condicion_tipo === 'palabra_clave'}
                  helper={
                    r.condicion_tipo === 'palabra_clave'
                      ? 'Palabras separadas por comas'
                      : 'Tema concreto a detectar'
                  }
                  error={err(`reglas.${i}.valor`)}
                >
                  <TextInput
                    id={`regla-valor-${i}`}
                    name={`reglas[${i}].valor`}
                    value={r.valor}
                    onChange={(v) => update(i, { valor: v })}
                    placeholder={step.fields.reglas.subfields.valor.placeholder}
                  />
                </FieldRow>
              ) : null}
              {r.accion === 'derivar_humano' ? (
                <FieldRow
                  label={step.fields.reglas.subfields.destino.label}
                  htmlFor={`regla-destino-${i}`}
                  required
                  error={err(`reglas.${i}.destino`)}
                >
                  <TextInput
                    id={`regla-destino-${i}`}
                    name={`reglas[${i}].destino`}
                    value={r.destino}
                    onChange={(v) => update(i, { destino: v })}
                    placeholder={step.fields.reglas.subfields.destino.placeholder}
                  />
                </FieldRow>
              ) : null}
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => remove(i)}>
                  Quitar regla
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button variant="ghost" onClick={add}>
              + {step.fields.reglas.addRule}
            </Button>
          </div>
        </div>
      </div>

      <RadioGroup
        legend={step.fields.fallback_sin_respuesta.label}
        name="fallback_sin_respuesta"
        options={FALLBACK_OPTIONS}
        value={fallback}
        onChange={onFallbackChange}
        error={err('fallback_sin_respuesta')}
      />
    </div>
  );
}
