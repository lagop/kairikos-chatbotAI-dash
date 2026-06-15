'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step9Schema, type Step9Input } from '@/lib/wizard-schemas';
import { MENSAJE_BIENVENIDA_TEMPLATE } from '@/lib/wizard-templates';
import { useZodValidation } from './useZodValidation';
import { Button, FieldRow, Textarea, TextInput } from './primitives';

interface Props {
  value: Step9Input | null;
  nombreComercial: string | null;
  onChange: (value: Step9Input) => void;
}

const emptyPrompt: string = '';

export function Step9Mensajes({ value, nombreComercial, onChange }: Props) {
  const step = getStep(9);
  const suggestedBienvenida = MENSAJE_BIENVENIDA_TEMPLATE.replace(
    '{nombre_comercial}',
    nombreComercial || 'tu negocio',
  );

  const [bienvenida, setBienvenida] = useState<string>(value?.mensaje_bienvenida ?? suggestedBienvenida);
  const [prompts, setPrompts] = useState<string[]>(value?.prompts_sugeridos ?? []);
  const [despedida, setDespedida] = useState<string>(value?.mensaje_despedida ?? '');

  const { errorMap } = useZodValidation(step9Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (b: string, p: string[], d: string) => {
    const payload: Step9Input = {
      mensaje_bienvenida: b,
      prompts_sugeridos: p.map((x) => x.trim()).filter(Boolean),
      mensaje_despedida: d,
    };
    const r = step9Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const onBienvenidaChange = (v: string) => {
    setBienvenida(v);
    emit(v, prompts, despedida);
  };
  const onDespedidaChange = (v: string) => {
    setDespedida(v);
    emit(bienvenida, prompts, v);
  };
  const addPrompt = () => {
    if (prompts.length >= 5) return;
    const next = [...prompts, emptyPrompt];
    setPrompts(next);
    emit(bienvenida, next, despedida);
  };
  const updatePrompt = (i: number, v: string) => {
    const next = prompts.map((p, idx) => (idx === i ? v : p));
    setPrompts(next);
    emit(bienvenida, next, despedida);
  };
  const removePrompt = (i: number) => {
    const next = prompts.filter((_, idx) => idx !== i);
    setPrompts(next);
    emit(bienvenida, next, despedida);
  };

  return (
    <div className="space-y-5">
      <FieldRow
        label={step.fields.mensaje_bienvenida.label}
        htmlFor="mensaje_bienvenida"
        required
        helper={step.fields.mensaje_bienvenida.helper}
        error={err('mensaje_bienvenida')}
      >
        <Textarea
          id="mensaje_bienvenida"
          name="mensaje_bienvenida"
          value={bienvenida}
          onChange={onBienvenidaChange}
          placeholder={step.fields.mensaje_bienvenida.placeholder}
          maxLength={300}
          rows={3}
        />
        <p className="mt-1 text-xs text-kairikos-muted">
          Sugerencia: <span className="italic">{suggestedBienvenida}</span>
        </p>
      </FieldRow>

      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.prompts_sugeridos.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.prompts_sugeridos.helper}
        </p>
        <div className="space-y-2">
          {prompts.map((p, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row">
              <TextInput
                id={`prompt-${i}`}
                name={`prompts_sugeridos[${i}]`}
                value={p}
                onChange={(v) => updatePrompt(i, v)}
                placeholder={step.fields.prompts_sugeridos.placeholder}
                maxLength={60}
              />
              <Button variant="ghost" onClick={() => removePrompt(i)}>
                Quitar
              </Button>
            </div>
          ))}
          {prompts.length < 5 ? (
            <Button variant="ghost" onClick={addPrompt}>
              + {step.fields.prompts_sugeridos.addPrompt}
            </Button>
          ) : null}
        </div>
        {err('prompts_sugeridos') ? (
          <p role="alert" className="mt-1 text-xs text-kairikos-danger">
            {err('prompts_sugeridos')}
          </p>
        ) : null}
      </div>

      <FieldRow
        label={step.fields.mensaje_despedida.label}
        htmlFor="mensaje_despedida"
        helper={step.fields.mensaje_despedida.helper}
        error={err('mensaje_despedida')}
      >
        <Textarea
          id="mensaje_despedida"
          name="mensaje_despedida"
          value={despedida}
          onChange={onDespedidaChange}
          placeholder={step.fields.mensaje_despedida.placeholder}
          maxLength={200}
          rows={2}
        />
      </FieldRow>
    </div>
  );
}
