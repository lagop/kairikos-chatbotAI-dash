'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step11Schema, type Step11Input } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import { Button, FieldRow, TextInput, Textarea } from './primitives';

interface Props {
  value: Step11Input | null;
  onChange: (value: Step11Input) => void;
}

interface TestDraft {
  pregunta: string;
  respuesta_esperada: string;
}

const emptyTest: TestDraft = { pregunta: '', respuesta_esperada: '' };

function fromSaved(s: Record<string, unknown>): TestDraft {
  return {
    pregunta: String(s.pregunta ?? ''),
    respuesta_esperada: String(s.respuesta_esperada ?? ''),
  };
}

export function Step11Pruebas({ value, onChange }: Props) {
  const step = getStep(11);
  const [tests, setTests] = useState<TestDraft[]>(
    (value?.test_qa ?? []).map((t) => fromSaved(t as Record<string, unknown>)),
  );

  const { errorMap } = useZodValidation(step11Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (next: TestDraft[]) => {
    const payload: Step11Input = {
      test_qa: next.map((t) => ({ pregunta: t.pregunta.trim(), respuesta_esperada: t.respuesta_esperada.trim() || undefined })),
    };
    const r = step11Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const update = (i: number, patch: Partial<TestDraft>) => {
    const next = tests.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
    setTests(next);
    emit(next);
  };
  const add = () => {
    const next = [...tests, emptyTest];
    setTests(next);
    emit(next);
  };
  const remove = (i: number) => {
    const next = tests.filter((_, idx) => idx !== i);
    setTests(next);
    emit(next);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-kairikos-warning/20 bg-kairikos-warning/5 p-4">
        <p className="text-sm font-semibold text-kairikos-warning">Modo pruebas activo</p>
        <p className="mt-1 text-sm text-kairikos-muted">
          El operador revisará este paso con atención. Añade preguntas que cubran los casos principales: horarios, precios, derivación.
        </p>
      </div>

      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.test_qa.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.test_qa.helper}
        </p>
        <div className="space-y-3">
          {tests.map((t, i) => (
            <div
              key={i}
              className="space-y-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3"
            >
              <FieldRow
                label={step.fields.test_qa.subfields.pregunta.label}
                htmlFor={`test-pregunta-${i}`}
                required
                error={err(`test_qa.${i}.pregunta`)}
              >
                <TextInput
                  id={`test-pregunta-${i}`}
                  name={`test_qa[${i}].pregunta`}
                  value={t.pregunta}
                  onChange={(v) => update(i, { pregunta: v })}
                  placeholder={step.fields.test_qa.subfields.pregunta.placeholder}
                  maxLength={200}
                />
              </FieldRow>
              <FieldRow
                label={step.fields.test_qa.subfields.respuesta_esperada.label}
                htmlFor={`test-respuesta-${i}`}
                error={err(`test_qa.${i}.respuesta_esperada`)}
              >
                <Textarea
                  id={`test-respuesta-${i}`}
                  name={`test_qa[${i}].respuesta_esperada`}
                  value={t.respuesta_esperada}
                  onChange={(v) => update(i, { respuesta_esperada: v })}
                  placeholder={step.fields.test_qa.subfields.respuesta_esperada.placeholder}
                  maxLength={500}
                  rows={2}
                />
              </FieldRow>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => remove(i)}>
                  Quitar
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button variant="ghost" onClick={add}>
              + {step.fields.test_qa.addTest}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
