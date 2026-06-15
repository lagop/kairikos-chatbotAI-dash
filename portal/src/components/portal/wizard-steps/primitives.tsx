'use client';

import type { ReactNode } from 'react';

export function FieldRow({
  label,
  htmlFor,
  required,
  helper,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  helper?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-kairikos-text"
      >
        {label}
        {required ? (
          <span aria-hidden className="ml-1 text-kairikos-danger">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-kairikos-danger">
          {error}
        </p>
      ) : helper ? (
        <p className="text-xs text-kairikos-muted">{helper}</p>
      ) : null}
    </div>
  );
}

export function TextInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  autoComplete,
  maxLength,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'tel' | 'number' | 'time';
  inputMode?: 'text' | 'email' | 'url' | 'tel' | 'numeric' | 'decimal';
  autoComplete?: string;
  maxLength?: number;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  return (
    <input
      id={id}
      name={name}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      inputMode={inputMode}
      autoComplete={autoComplete}
      maxLength={maxLength}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid || undefined}
      className="input"
    />
  );
}

export function Textarea({
  id,
  name,
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  return (
    <textarea
      id={id}
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      maxLength={maxLength}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid || undefined}
      className="input min-h-[88px]"
    />
  );
}

export function Select({
  id,
  name,
  value,
  onChange,
  options,
  ariaDescribedBy,
  ariaInvalid,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
}) {
  return (
    <select
      id={id}
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid || undefined}
      className="input"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CheckboxGroup({
  legend,
  name,
  options,
  values,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  values: string[];
  onChange: (v: string[]) => void;
  error?: string;
}) {
  const toggle = (v: string, checked: boolean) => {
    if (checked) {
      onChange([...new Set([...values, v])]);
    } else {
      onChange(values.filter((x) => x !== v));
    }
  };
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-kairikos-text">
        {legend}
      </legend>
      <div className="space-y-2">
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          const checked = values.includes(o.value);
          return (
            <label
              key={o.value}
              htmlFor={id}
              className="flex items-start gap-2 rounded-lg border border-kairikos-border bg-kairikos-surface2 px-3 py-2 text-sm"
            >
              <input
                id={id}
                name={name}
                type="checkbox"
                value={o.value}
                checked={checked}
                onChange={(e) => toggle(o.value, e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-kairikos-border bg-kairikos-surface2 text-kairikos-accent focus:ring-kairikos-accent"
              />
              <span className="text-kairikos-text">{o.label}</span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-kairikos-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-kairikos-text">
        {legend}
      </legend>
      <div className="space-y-2">
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className="flex items-start gap-2 rounded-lg border border-kairikos-border bg-kairikos-surface2 px-3 py-2 text-sm"
            >
              <input
                id={id}
                name={name}
                type="radio"
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
                className="mt-0.5 h-4 w-4 border-kairikos-border bg-kairikos-surface2 text-kairikos-accent focus:ring-kairikos-accent"
              />
              <span className="text-kairikos-text">{o.label}</span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-kairikos-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function Toggle({
  id,
  name,
  checked,
  onChange,
  label,
  helper,
  disabled,
}: {
  id: string;
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  helper?: string;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <input
        id={id}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-kairikos-border bg-kairikos-surface2 text-kairikos-accent focus:ring-kairikos-accent"
      />
      <span>
        <span className="block text-sm font-medium text-kairikos-text">{label}</span>
        {helper ? (
          <span className="mt-0.5 block text-xs text-kairikos-muted">{helper}</span>
        ) : null}
      </span>
    </label>
  );
}

export function Button({
  variant,
  type = 'button',
  onClick,
  disabled,
  children,
}: {
  variant: 'primary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const className =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'danger'
        ? 'btn-danger'
        : 'btn-ghost';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
}
