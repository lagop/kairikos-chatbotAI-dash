'use client';

import { useState } from 'react';
import { getStep } from '@/messages/wizard-es';
import { step3Schema, type Step3Input } from '@/lib/wizard-schemas';
import { useZodValidation } from './useZodValidation';
import {
  Button,
  FieldRow,
  Select,
  TextInput,
} from './primitives';

interface Props {
  value: Step3Input | null;
  vertical: string | null;
  onChange: (value: Step3Input) => void;
}

const PRECIO_TIPO_OPTIONS = [
  { value: 'fijo', label: 'Fijo' },
  { value: 'desde', label: 'Desde' },
  { value: 'consultar', label: 'Consultar' },
];

interface ServicioDraft {
  nombre: string;
  descripcion: string;
  precio_tipo: 'fijo' | 'desde' | 'consultar';
  precio_valor: string;
  duracion_min: string;
}

const emptyServicio: ServicioDraft = {
  nombre: '',
  descripcion: '',
  precio_tipo: 'consultar',
  precio_valor: '',
  duracion_min: '',
};

function toServicio(d: ServicioDraft) {
  return {
    nombre: d.nombre.trim(),
    descripcion: d.descripcion.trim(),
    precio_tipo: d.precio_tipo,
    precio_valor:
      d.precio_valor === '' || d.precio_valor == null
        ? undefined
        : Number(d.precio_valor),
    duracion_min:
      d.duracion_min === '' || d.duracion_min == null
        ? undefined
        : Number(d.duracion_min),
  };
}

function fromSaved(s: Record<string, unknown>): ServicioDraft {
  return {
    nombre: String(s.nombre ?? ''),
    descripcion: String(s.descripcion ?? ''),
    precio_tipo: (s.precio_tipo as ServicioDraft['precio_tipo']) ?? 'consultar',
    precio_valor: s.precio_valor == null ? '' : String(s.precio_valor),
    duracion_min: s.duracion_min == null ? '' : String(s.duracion_min),
  };
}

export function Step3Servicios({ value, vertical, onChange }: Props) {
  const step = getStep(3);
  const isInmobiliaria = vertical === 'inmobiliaria';

  const initialServicios = (value?.servicios ?? []).map((s) => fromSaved(s as Record<string, unknown>));
  const [servicios, setServicios] = useState<ServicioDraft[]>(initialServicios);
  const [portalUrl, setPortalUrl] = useState<string>(value?.portal_propiedades_url ?? '');

  const { errorMap } = useZodValidation(step3Schema);

  const emit = (next: ServicioDraft[], portal: string) => {
    const payload: Step3Input = {
      servicios: next.map(toServicio),
      portal_propiedades_url: portal,
      vertical: vertical ?? undefined,
    };
    const r = step3Schema.safeParse(payload);
    if (r.success) onChange(r.data);
  };

  const update = (i: number, patch: Partial<ServicioDraft>) => {
    const next = servicios.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    setServicios(next);
    emit(next, portalUrl);
  };
  const add = () => {
    const next = [...servicios, emptyServicio];
    setServicios(next);
    emit(next, portalUrl);
  };
  const remove = (i: number) => {
    const next = servicios.filter((_, idx) => idx !== i);
    setServicios(next);
    emit(next, portalUrl);
  };

  const onPortalChange = (v: string) => {
    setPortalUrl(v);
    emit(servicios, v);
  };

  const err = (path: string) => errorMap.get(path);

  return (
    <div className="space-y-5">
      {isInmobiliaria ? (
        <FieldRow
          label={step.fields.portal_propiedades_url.label}
          htmlFor="portal_propiedades_url"
          required
          helper={step.fields.portal_propiedades_url.helper}
          error={err('portal_propiedades_url')}
        >
          <TextInput
            id="portal_propiedades_url"
            name="portal_propiedades_url"
            type="url"
            inputMode="url"
            value={portalUrl}
            onChange={onPortalChange}
            placeholder={step.fields.portal_propiedades_url.placeholder}
          />
        </FieldRow>
      ) : (
        <>
          <div>
            <p className="mb-1.5 block text-sm font-medium text-kairikos-text">
              {step.fields.servicios.label}
            </p>
            <p className="mb-2 text-xs text-kairikos-muted">
              {step.fields.servicios.helper}
            </p>
            <div className="space-y-3">
              {servicios.map((s, i) => (
                <div
                  key={i}
                  className="space-y-3 rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldRow
                      label={step.fields.servicios.subfields.nombre.label}
                      htmlFor={`servicio-nombre-${i}`}
                      required
                      error={err(`servicios.${i}.nombre`)}
                    >
                      <TextInput
                        id={`servicio-nombre-${i}`}
                        name={`servicios[${i}].nombre`}
                        value={s.nombre}
                        onChange={(v) => update(i, { nombre: v })}
                        placeholder={step.fields.servicios.subfields.nombre.placeholder}
                        maxLength={80}
                      />
                    </FieldRow>
                    <FieldRow
                      label={step.fields.servicios.subfields.descripcion.label}
                      htmlFor={`servicio-descripcion-${i}`}
                      required
                      error={err(`servicios.${i}.descripcion`)}
                    >
                      <TextInput
                        id={`servicio-descripcion-${i}`}
                        name={`servicios[${i}].descripcion`}
                        value={s.descripcion}
                        onChange={(v) => update(i, { descripcion: v })}
                        placeholder={step.fields.servicios.subfields.descripcion.placeholder}
                        maxLength={300}
                      />
                    </FieldRow>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FieldRow
                      label={step.fields.servicios.subfields.precio_tipo.label}
                      htmlFor={`servicio-precio-tipo-${i}`}
                      required
                      error={err(`servicios.${i}.precio_tipo`)}
                    >
                      <Select
                        id={`servicio-precio-tipo-${i}`}
                        name={`servicios[${i}].precio_tipo`}
                        value={s.precio_tipo}
                        onChange={(v) => update(i, { precio_tipo: v as ServicioDraft['precio_tipo'] })}
                        options={PRECIO_TIPO_OPTIONS}
                      />
                    </FieldRow>
                    <FieldRow
                      label={step.fields.servicios.subfields.precio_valor.label}
                      htmlFor={`servicio-precio-valor-${i}`}
                      required={s.precio_tipo !== 'consultar'}
                      error={err(`servicios.${i}.precio_valor`)}
                    >
                      <TextInput
                        id={`servicio-precio-valor-${i}`}
                        name={`servicios[${i}].precio_valor`}
                        type="number"
                        inputMode="decimal"
                        value={s.precio_valor}
                        onChange={(v) => update(i, { precio_valor: v })}
                        placeholder={step.fields.servicios.subfields.precio_valor.placeholder}
                      />
                    </FieldRow>
                    <FieldRow
                      label={step.fields.servicios.subfields.duracion_min.label}
                      htmlFor={`servicio-duracion-${i}`}
                      error={err(`servicios.${i}.duracion_min`)}
                    >
                      <TextInput
                        id={`servicio-duracion-${i}`}
                        name={`servicios[${i}].duracion_min`}
                        type="number"
                        inputMode="numeric"
                        value={s.duracion_min}
                        onChange={(v) => update(i, { duracion_min: v })}
                        placeholder={step.fields.servicios.subfields.duracion_min.placeholder}
                      />
                    </FieldRow>
                  </div>
                  <div className="flex justify-end">
                    <Button variant="ghost" onClick={() => remove(i)}>
                      Quitar servicio
                    </Button>
                  </div>
                </div>
              ))}
              {servicios.length === 0 ? (
                <p className="text-sm text-kairikos-muted">
                  Añade al menos un servicio o producto.
                </p>
              ) : null}
              <div>
                <Button variant="ghost" onClick={add}>
                  + {step.fields.servicios.addService}
                </Button>
              </div>
            </div>
            {err('servicios') ? (
              <p role="alert" className="mt-2 text-xs text-kairikos-danger">
                {err('servicios')}
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
