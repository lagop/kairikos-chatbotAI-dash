'use client';

import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';
import { getErrors, type ErrorMessages } from '@/messages/wizard-es';

export interface FieldError {
  path: string;
  message: string;
}

interface ZodIssueLike {
  code: string;
  path: Array<string | number>;
  message: string;
  minimum?: number;
  maximum?: number;
  type?: string;
}

export function formatZodErrors(
  err: z.ZodError,
  errors: ErrorMessages = getErrors(),
): FieldError[] {
  return err.issues.map((raw) => {
    const i = raw as unknown as ZodIssueLike;
    const code = i.code;
    const path = i.path.join('.');
    const m = i.message;
    let msg: string = m;

    if (code === 'invalid_type' && m === 'required') {
      msg = errors.required;
    } else if (code === 'too_small') {
      const min = Number(i.minimum ?? 0);
      if (i.type === 'string') msg = errors.minLength(min);
      else if (i.type === 'array') msg = errors.minItems(min);
      else if (i.type === 'number') msg = errors.numberMin(min);
    } else if (code === 'too_big') {
      const max = Number(i.maximum ?? 0);
      if (i.type === 'string') msg = errors.maxLength(max);
      else if (i.type === 'array') msg = errors.maxItems(max);
      else if (i.type === 'number') msg = errors.numberMax(max);
    } else if (code === 'invalid_string' || code === 'invalid_format') {
      if (i.type === 'email') msg = errors.email;
      else if (i.type === 'url') msg = errors.url;
      else msg = errors.invalidFormat;
    } else if (code === 'invalid_enum_value') {
      msg = errors.selectRequired;
    } else if (code === 'custom') {
      if (m === 'required') msg = errors.required;
      else if (m === 'minItems') msg = errors.minItems(1);
      else if (m === 'checkboxRequired') msg = errors.checkboxRequired;
      else if (m === 'email') msg = errors.email;
      else if (m === 'url') msg = errors.url;
      else if (m === 'valueMismatch') msg = errors.valueMismatch;
      else if (m === 'invalidTime') msg = errors.invalidTime;
    } else if (code === 'too_small' && m === 'required') {
      msg = errors.required;
    } else if (m === 'required' || m === 'Required') {
      msg = errors.required;
    } else if (m === 'checkboxRequired') {
      msg = errors.checkboxRequired;
    } else if (m === 'minItems') {
      msg = errors.minItems(1);
    } else if (m === 'invalidTime') {
      msg = errors.invalidTime;
    } else if (m === 'valueMismatch') {
      msg = errors.valueMismatch;
    }

    return { path, message: msg };
  });
}

export function useZodValidation<S extends z.ZodTypeAny>(schema: S) {
  const [errors, setErrors] = useState<FieldError[]>([]);

  const validate = useCallback(
    (data: unknown): { ok: true; data: z.infer<S> } | { ok: false; errors: FieldError[] } => {
      const result = schema.safeParse(data);
      if (result.success) {
        setErrors([]);
        return { ok: true, data: result.data as z.infer<S> };
      }
      const fe = formatZodErrors(result.error);
      setErrors(fe);
      return { ok: false, errors: fe };
    },
    [schema],
  );

  const errorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of errors) m.set(e.path, e.message);
    return m;
  }, [errors]);

  const clear = useCallback(() => setErrors([]), []);

  return { errors, errorMap, validate, clear };
}
