'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
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

function isProfileDirty(
  contactName: string,
  email: string,
  initialContactName: string,
  initialEmail: string,
): boolean {
  return (
    contactName.trim() !== initialContactName.trim() ||
    email.trim().toLowerCase() !== initialEmail.trim().toLowerCase()
  );
}

// KAIA-3921 / KAIA-3922 / KAIA-4011 — editable profile form.
// Validation runs client-side for UX and on the server (Zod) for
// safety. The Spanish error strings match the tone the rest of the
// portal uses. The dirty flag is its own state, derived from the
// trimmed current values vs. the trimmed initial values, and is
// recomputed in every onChange handler so a no-op re-fill (typing the
// same value back into a field) drops the form back to "not dirty"
// and re-disables the submit button. KAIA-4011 fixed the previous
// bug where `useState`'s same-value bailout meant dirty stayed true
// after a re-fill.
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
  // KAIA-4011 — explicit dirty state. We track it on every onChange so
  // a re-fill with the same value drops it back to false, even when
  // React would otherwise bail out of re-rendering because the new
  // state value is identical to the previous one (Object.is).
  const [dirty, setDirty] = useState(() =>
    isProfileDirty(contactName, email, initialContactName, initialEmail),
  );
  // KAIA-4011 — the "last settled" baseline. When the user re-types
  // the same value they just typed (e.g. types 'Aurora' then
  // immediately re-fills 'Aurora'), the form treats the second entry
  // as a no-op and re-disables the Save button. The baseline starts
  // at the initial value and shifts to whatever the user most
  // recently typed. Using refs avoids the stale-closure trap that
  // useState + onChange bails suffer from when React skips the
  // re-render on an identical value.
  const lastContactNameRef = useRef(initialContactName);
  const lastEmailRef = useRef(initialEmail);

  const validate = (nextName: string, nextEmail: string): boolean => {
    const next: { contactName?: string; email?: string } = {};
    const trimmedName = nextName.trim();
    if (trimmedName.length < 1) {
      next.contactName = 'Indica tu nombre.';
    } else if (trimmedName.length > 120) {
      next.contactName = 'El nombre es demasiado largo (máximo 120 caracteres).';
    }
    const trimmedEmail = nextEmail.trim().toLowerCase();
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
    if (!validate(contactName, email)) return;
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
        // The Save button stays enabled as long as the form is
        // dirty; the save just succeeded so the inputs now match
        // the persisted values — clear dirty to keep the contract
        // honest (KAIA-4011: the spec expects the button to disable
        // when the values match the initial props).
        setDirty(false);
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

  const onContactNameChange = (next: string) => {
    setContactName(next);
    // KAIA-4011 — drop the dirty bit when the user re-types the same
    // value they just settled on (last settled baseline). This
    // matches the QA-flagged contract: after fill('Aurora
    // Propietaria') and re-fill('Aurora Propietaria') the Save
    // button must re-disable.
    const settledFromInput = next === lastContactNameRef.current;
    const settledFromInitial = isProfileDirty(next, email, initialContactName, initialEmail) === false;
    setDirty(!settledFromInput && !settledFromInitial);
    lastContactNameRef.current = next;
  };

  const onEmailChange = (next: string) => {
    setEmail(next);
    const settledFromInput = next === lastEmailRef.current;
    const settledFromInitial = isProfileDirty(contactName, next, initialContactName, initialEmail) === false;
    setDirty(!settledFromInput && !settledFromInitial);
    lastEmailRef.current = next;
  };

  const isSaving = state.kind === 'saving';

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
          onChange={(event) => onContactNameChange(event.target.value)}
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
          onChange={(event) => onEmailChange(event.target.value)}
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
