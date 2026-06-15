'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step10Schema, type Step10Input, COMPLIANCE_TEMPLATES } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import { FieldRow, TextInput } from './primitives';

interface Props {
  value: Step10Input | null;
  vertical: string | null;
  onChange: (value: Step10Input) => void;
}

function plantillaBase(vertical: string | null): string {
  if (vertical && COMPLIANCE_TEMPLATES[vertical]) return COMPLIANCE_TEMPLATES[vertical].plantilla_base;
  return COMPLIANCE_TEMPLATES.default.plantilla_base;
}

function bloque(vertical: string | null, kind: 'salud' | 'secreto'): string | undefined {
  if (kind === 'salud' && vertical === 'clinica') {
    return 'Bloque adicional (art. 9 RGPD): el bot trata categorías especiales de datos (salud). El cliente consiente su tratamiento para la finalidad indicada.';
  }
  if (kind === 'secreto' && vertical === 'abogado') {
    return 'Bloque adicional (secreto profesional): la información facilitada a través del bot está sujeta al deber de secreto profesional del abogado.';
  }
  return undefined;
}

export function Step10Cumplimiento({ value, vertical, onChange }: Props) {
  const step = getStep(10);
  const [responsable, setResponsable] = useState<string>(value?.responsable_tratamiento ?? '');
  const [emailDpo, setEmailDpo] = useState<string>(value?.email_dpo ?? '');
  const [url, setUrl] = useState<string>(value?.url_politica_privacidad ?? '');
  const [retencion, setRetencion] = useState<string>(
    value?.retencion_leads_dias == null ? '' : String(value.retencion_leads_dias),
  );

  const { errorMap } = useZodValidation(step10Schema);
  const err = (path: string) => errorMap.get(path);

  const emit = (r: string, e: string, u: string, ret: string) => {
    const payload: Step10Input = {
      responsable_tratamiento: r.trim(),
      email_dpo: e.trim() || undefined,
      url_politica_privacidad: u.trim(),
      retencion_leads_dias: ret === '' ? undefined : Number(ret),
      plantilla_base: plantillaBase(vertical),
      bloque_salud: bloque(vertical, 'salud'),
      bloque_secreto_profesional: bloque(vertical, 'secreto'),
      vertical: vertical ?? undefined,
    };
    const r2 = step10Schema.safeParse(payload);
    if (r2.success) onChange(r2.data);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4">
        <p className="text-sm font-medium text-kairikos-text">Plantilla base (RGPD)</p>
        <p className="mt-1 text-xs text-kairikos-muted">{plantillaBase(vertical)}</p>
        {bloque(vertical, 'salud') ? (
          <>
            <p className="mt-3 text-sm font-medium text-kairikos-text">Bloque salud</p>
            <p className="mt-1 text-xs text-kairikos-muted">{bloque(vertical, 'salud')}</p>
          </>
        ) : null}
        {bloque(vertical, 'secreto') ? (
          <>
            <p className="mt-3 text-sm font-medium text-kairikos-text">Bloque secreto profesional</p>
            <p className="mt-1 text-xs text-kairikos-muted">{bloque(vertical, 'secreto')}</p>
          </>
        ) : null}
      </div>

      <FieldRow
        label={step.fields.responsable_tratamiento.label}
        htmlFor="responsable_tratamiento"
        required
        helper={step.fields.responsable_tratamiento.helper}
        error={err('responsable_tratamiento')}
      >
        <TextInput
          id="responsable_tratamiento"
          name="responsable_tratamiento"
          value={responsable}
          onChange={(v) => {
            setResponsable(v);
            emit(v, emailDpo, url, retencion);
          }}
          placeholder={step.fields.responsable_tratamiento.placeholder}
          maxLength={120}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.email_dpo.label}
        htmlFor="email_dpo"
        helper={
          vertical === 'clinica' || vertical === 'abogado'
            ? 'Obligatorio para clínicas y despachos (RGPD + secreto profesional).'
            : step.fields.email_dpo.helper
        }
        error={err('email_dpo')}
      >
        <TextInput
          id="email_dpo"
          name="email_dpo"
          type="email"
          inputMode="email"
          value={emailDpo}
          onChange={(v) => {
            setEmailDpo(v);
            emit(responsable, v, url, retencion);
          }}
          placeholder={step.fields.email_dpo.placeholder}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.url_politica_privacidad.label}
        htmlFor="url_politica_privacidad"
        required
        helper={step.fields.url_politica_privacidad.helper}
        error={err('url_politica_privacidad')}
      >
        <TextInput
          id="url_politica_privacidad"
          name="url_politica_privacidad"
          type="url"
          inputMode="url"
          value={url}
          onChange={(v) => {
            setUrl(v);
            emit(responsable, emailDpo, v, retencion);
          }}
          placeholder={step.fields.url_politica_privacidad.placeholder}
        />
      </FieldRow>

      <FieldRow
        label={step.fields.retencion_leads_dias.label}
        htmlFor="retencion_leads_dias"
        helper={step.fields.retencion_leads_dias.helper}
        error={err('retencion_leads_dias')}
      >
        <TextInput
          id="retencion_leads_dias"
          name="retencion_leads_dias"
          type="number"
          inputMode="numeric"
          value={retencion}
          onChange={(v) => {
            setRetencion(v);
            emit(responsable, emailDpo, url, v);
          }}
          placeholder={step.fields.retencion_leads_dias.placeholder}
        />
      </FieldRow>
    </div>
  );
}
