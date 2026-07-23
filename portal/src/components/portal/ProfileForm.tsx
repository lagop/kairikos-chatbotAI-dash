'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface ProfileFormProps {
  initialContactName: string;
  initialEmail: string;
  // Optional caller label so the same form works on a future
  // operator-side admin view without copy-pasting the markup.
  emailLabel?: string;
  contactNameLabel?: string;
  submitLabel?: string;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

// Lightweight email regex — Zod on the server is the source of truth.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// KAIA-3921 / KAIA-3922 — editable profile form. Validation runs
// client-side for UX and on the server (Zod) for safety. The Spanish
// error strings match the tone the rest of the portal uses.
export function ProfileForm({
  initialContactName,
  initialEmail,
  emailLabel = 'Email de contacto',
  contactNameLabel = 'Tu nombre',
  submitLabel = 'Guardar cambios',
}: ProfileFormProps) {
  const router = useRouter();
  const nameId = useId();
  const emailId = useId();
  const errorId = useId();

  const [contactName, setContactName] = useState(initialContactName);
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [fieldErrors, setFieldErrors] = useState<{ contactName?: string; email?: string }>({});

  const validate = (): boolean => {
    const next: { contactName?: string; email?: string } = {};
    const trimmedName = contactName.trim();
    if (trimmedName.length < 1) {
      next.contactName = 'Indica tu nombre.';
    } else if (trimmedName.length > 120) {
      next.contactName = 'El nombre es demasiado largo (máximo 120 caracteres).';
    }
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      next.email = 'Indica tu email.';
    } else if (!EMAIL_RE.test(trimmedEmail) || trimmedEmail.length > 254) {
      next.email = 'Introduce un email válido.';
    } else if (trimmedEmail === initialEmail.trim().toLowerCase() && !trimmedName) {
      // No-op: keep the existing branch silent so the user doesn't
      // see a false-positive error when only the email "changes" by
      // case (the server lowercases anyway).
    }
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind === 'saving') return;
    if (!validate()) return;
    setState({ kind: 'saving' });
    try {
      const res = await fetch('/api/portal/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Backend (KAIA-3922) reads `name` as the contact name
          // (mapped to `ChatbotClient.name`). The schema is Zod
          // strict, so we only send allowlisted fields. Sending an
          // unchanged value is harmless; the route writes only
          // defined keys.
          name: contactName.trim(),
          primaryContactEmail: email.trim().toLowerCase(),
        }),
      });
      if (res.ok) {
        setState({ kind: 'success', message: 'Cambios guardados correctamente.' });
        router.refresh();
        return;
      }
      const detail = await safeReadDetail(res);
      setState({
        kind: 'error',
        message:
          detail ?? 'No hemos podido guardar los cambios. Inténtalo de nuevo en unos minutos.',
      });
    } catch (err) {
      setState({
        kind: 'error',
        message: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`,
      });
    }
  };

  const isSaving = state.kind === 'saving';
  const dirty =
    contactName.trim() !== initialContactName.trim() ||
    email.trim().toLowerCase() !== initialEmail.trim().toLowerCase();

  return (
    <form
      className="space-y-5"
      onSubmit={onSubmit}
      noValidate
      data-testid="profile-form"
      aria-describedby={state.kind === 'error' ? errorId : undefined}
    >
      <div>
        <label htmlFor={nameId} className="label">
          {contactNameLabel}
        </label>
        <input
          id={nameId}
          name="contactName"
          type="text"
          className="input"
          autoComplete="name"
          maxLength={120}
          required
          value={contactName}
          onChange={(event) => setContactName(event.target.value)}
          aria-invalid={Boolean(fieldErrors.contactName) || undefined}
          aria-describedby={fieldErrors.contactName ? `${nameId}-error` : undefined}
          data-testid="profile-contact-name"
        />
        {fieldErrors.contactName ? (
          <p id={`${nameId}-error`} className="mt-1 text-xs text-kairikos-danger">
            {fieldErrors.contactName}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={emailId} className="label">
          {emailLabel}
        </label>
        <input
          id={emailId}
          name="primaryContactEmail"
          type="email"
          className="input"
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(fieldErrors.email) || undefined}
          aria-describedby={fieldErrors.email ? `${emailId}-error` : undefined}
          data-testid="profile-email"
        />
        {fieldErrors.email ? (
          <p id={`${emailId}-error`} className="mt-1 text-xs text-kairikos-danger">
            {fieldErrors.email}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-kairikos-muted">
          Usamos este email para enviarte avisos del portal y para recuperar el acceso.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="submit"
          className="btn-primary w-full sm:w-auto"
          data-testid="profile-submit"
          disabled={isSaving || !dirty}
        >
          {isSaving ? 'Guardando…' : submitLabel}
        </button>
      </div>

      <div role="status" aria-live="polite" className="min-h-[1.5rem] text-sm">
        {state.kind === 'success' ? (
          <p
            className="rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-kairikos-success"
            data-testid="profile-status"
            data-status-kind="success"
          >
            {state.message}
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <p
            id={errorId}
            className="rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-kairikos-danger"
            data-testid="profile-status"
            data-status-kind="error"
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

async function safeReadDetail(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { detail?: string; error?: string };
    return data.detail ?? data.error ?? null;
  } catch {
    return null;
  }
}
