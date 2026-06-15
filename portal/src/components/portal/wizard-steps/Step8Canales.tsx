'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step8Schema, type Step8Input } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import { Toggle } from './primitives';

interface Props {
  value: Step8Input | null;
  onChange: (value: Step8Input) => void;
}

export function Step8Canales({ value, onChange }: Props) {
  const step = getStep(8);
  const [web, setWeb] = useState<boolean>(value?.canal_web ?? true);
  const [whatsapp, setWhatsapp] = useState<boolean>(value?.canal_whatsapp ?? false);

  const { errorMap } = useZodValidation(step8Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (w: boolean, wpp: boolean) => {
    const payload: Step8Input = { canal_web: w, canal_whatsapp: wpp };
    const r = step8Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const onWebChange = (v: boolean) => {
    setWeb(v);
    emit(v, whatsapp);
  };
  const onWppChange = (v: boolean) => {
    setWhatsapp(v);
    emit(web, v);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-kairikos-muted">
        Selecciona los canales donde funcionará el bot. Instagram no está disponible en v1 (está previsto para v2).
      </p>
      <div className="space-y-3">
        <Toggle
          id="canal_web"
          name="canal_web"
          checked={web}
          onChange={onWebChange}
          label={step.fields.canal_web.label}
          helper={step.fields.canal_web.helper}
        />
        <Toggle
          id="canal_whatsapp"
          name="canal_whatsapp"
          checked={whatsapp}
          onChange={onWppChange}
          label={step.fields.canal_whatsapp.label}
          helper={step.fields.canal_whatsapp.helper}
        />
        {step.fields.canal_whatsapp.note ? (
          <p className="text-xs text-kairikos-muted">
            {step.fields.canal_whatsapp.note}
          </p>
        ) : null}
        <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3 text-sm text-kairikos-muted">
          <span className="font-medium text-kairikos-text">Instagram</span>: {step.fields.canal_instagram.helper} ({step.fields.canal_instagram.disabled})
        </div>
      </div>
      {err('canal_web') ? (
        <p role="alert" className="text-xs text-kairikos-danger">
          {err('canal_web')}
        </p>
      ) : null}
    </div>
  );
}
