'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step4Schema, type Step4Input } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import { Button, FieldRow, TextInput, Textarea } from './primitives';

interface Props {
  value: Step4Input | null;
  onChange: (value: Step4Input) => void;
}

interface FaqDraft {
  pregunta: string;
  respuesta: string;
}

const emptyFaq: FaqDraft = { pregunta: '', respuesta: '' };

function fromSaved(s: Record<string, unknown>): FaqDraft {
  return {
    pregunta: String(s.pregunta ?? ''),
    respuesta: String(s.respuesta ?? ''),
  };
}

export function Step4Faq({ value, onChange }: Props) {
  const step = getStep(4);
  const [faqs, setFaqs] = useState<FaqDraft[]>(
    (value?.faq_items ?? []).map((s) => fromSaved(s as Record<string, unknown>)),
  );
  const [pasted, setPasted] = useState<string>(value?.faq_paste ?? '');

  const { errorMap } = useZodValidation(step4Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (next: FaqDraft[], p: string) => {
    const payload: Step4Input = {
      faq_items: next.map((f) => ({ pregunta: f.pregunta.trim(), respuesta: f.respuesta.trim() })),
      faq_paste: p,
    };
    const r = step4Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const update = (i: number, patch: Partial<FaqDraft>) => {
    const next = faqs.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    setFaqs(next);
    emit(next, pasted);
  };
  const add = () => {
    const next = [...faqs, emptyFaq];
    setFaqs(next);
    emit(next, pasted);
  };
  const remove = (i: number) => {
    const next = faqs.filter((_, idx) => idx !== i);
    setFaqs(next);
    emit(next, pasted);
  };

  const onPastedChange = (v: string) => {
    setPasted(v);
    emit(faqs, v);
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
          {step.fields.faq_items.label}
        </p>
        <p className="mb-2 text-xs text-kairikos-muted">
          {step.fields.faq_items.helper}
        </p>
        <div className="space-y-3">
          {faqs.map((f, i) => (
            <div
              key={i}
              className="space-y-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3"
            >
              <FieldRow
                label={step.fields.faq_items.subfields.pregunta.label}
                htmlFor={`faq-pregunta-${i}`}
                required
                error={err(`faq_items.${i}.pregunta`)}
              >
                <TextInput
                  id={`faq-pregunta-${i}`}
                  name={`faq_items[${i}].pregunta`}
                  value={f.pregunta}
                  onChange={(v) => update(i, { pregunta: v })}
                  placeholder={step.fields.faq_items.subfields.pregunta.placeholder}
                  maxLength={200}
                />
              </FieldRow>
              <FieldRow
                label={step.fields.faq_items.subfields.respuesta.label}
                htmlFor={`faq-respuesta-${i}`}
                required
                error={err(`faq_items.${i}.respuesta`)}
              >
                <Textarea
                  id={`faq-respuesta-${i}`}
                  name={`faq_items[${i}].respuesta`}
                  value={f.respuesta}
                  onChange={(v) => update(i, { respuesta: v })}
                  placeholder={step.fields.faq_items.subfields.respuesta.placeholder}
                  maxLength={1000}
                  rows={3}
                />
              </FieldRow>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => remove(i)}>
                  Quitar pregunta
                </Button>
              </div>
            </div>
          ))}
          {faqs.length === 0 ? (
            <p className="text-sm text-kairikos-muted">
              Añade al menos una pregunta o pega el contenido abajo.
            </p>
          ) : null}
          <div>
            <Button variant="ghost" onClick={add}>
              + {step.fields.faq_items.addQuestion}
            </Button>
          </div>
        </div>
        {err('faq_items') ? (
          <p role="alert" className="mt-2 text-xs text-kairikos-danger">
            {err('faq_items')}
          </p>
        ) : null}
      </div>

      <FieldRow
        label={step.fields.faq_paste.label}
        htmlFor="faq_paste"
        helper={step.fields.faq_paste.helper}
      >
        <Textarea
          id="faq_paste"
          name="faq_paste"
          value={pasted}
          onChange={onPastedChange}
          placeholder={step.fields.faq_paste.placeholder}
          rows={6}
        />
      </FieldRow>
    </div>
  );
}
