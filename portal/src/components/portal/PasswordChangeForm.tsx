'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';

type ChangeState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

// KAIA-3921 / KAIA-3922 — client-side password change form. The
// server endpoint (`POST /api/portal/me/password`) is owned by the
// backend and is currently in dev-mock 503. When the server returns
// `reauth_required: true`, the frontend signs out and forces a fresh
// login so any leaked JWT cookie cannot outlive the credential
// rotation.
//
// All validation messages are in Spanish to match the portal tone.
export function PasswordChangeForm() {
  const router = useRouter();
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();
  const errorId = useId();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [state, setState] = useState<ChangeState>({ kind: 'idle' });
  const [fieldErrors, setFieldErrors] = useState<{
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  }>({});

  const validate = (): boolean => {
    const next: {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    } = {};
    if (!currentPassword) {
      next.currentPassword = 'Introduce tu contraseña actual.';
    }
    if (newPassword.length < 8) {
      next.newPassword = 'La nueva contraseña debe tener al menos 8 caracteres.';
    } else if (newPassword.length > 128) {
      next.newPassword = 'La nueva contraseña es demasiado larga (máximo 128 caracteres).';
    } else if (newPassword === currentPassword) {
      next.newPassword = 'La nueva contraseña debe ser diferente de la actual.';
    }
    if (confirmPassword !== newPassword) {
      next.confirmPassword = 'La confirmación no coincide con la nueva contraseña.';
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
      const res = await fetch('/api/portal/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { reauth_required?: boolean };
        setState({
          kind: 'success',
          message: 'Contraseña actualizada. Volvemos a iniciar sesión para aplicar los cambios.',
        });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        // Backend signals reauth_required on every successful rotation.
        // Sign the client out so any leaked JWT cookie stops being
        // accepted. After sign-out we route to /portal/login.
        if (data.reauth_required) {
          await signOut({ redirect: false });
          router.push('/portal/login?reason=password_changed');
          router.refresh();
        }
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setState({ kind: 'error', message: mapPasswordError(res.status, data.error) });
    } catch (err) {
      setState({
        kind: 'error',
        message: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`,
      });
    }
  };

  const isSaving = state.kind === 'saving';
  const dirty = currentPassword.length > 0 && newPassword.length > 0 && confirmPassword.length > 0;

  return (
    <form
      className="space-y-5"
      onSubmit={onSubmit}
      noValidate
      data-testid="password-form"
      aria-describedby={state.kind === 'error' ? errorId : undefined}
    >
      <div>
        <label htmlFor={currentId} className="label">
          Contraseña actual
        </label>
        <input
          id={currentId}
          name="currentPassword"
          type="password"
          className="input"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          aria-invalid={Boolean(fieldErrors.currentPassword) || undefined}
          aria-describedby={
            fieldErrors.currentPassword ? `${currentId}-error` : undefined
          }
          data-testid="password-current"
        />
        {fieldErrors.currentPassword ? (
          <p id={`${currentId}-error`} className="mt-1 text-xs text-kairikos-danger">
            {fieldErrors.currentPassword}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={nextId} className="label">
          Nueva contraseña
        </label>
        <input
          id={nextId}
          name="newPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          aria-invalid={Boolean(fieldErrors.newPassword) || undefined}
          aria-describedby={fieldErrors.newPassword ? `${nextId}-error` : undefined}
          data-testid="password-new"
        />
        {fieldErrors.newPassword ? (
          <p id={`${nextId}-error`} className="mt-1 text-xs text-kairikos-danger">
            {fieldErrors.newPassword}
          </p>
        ) : (
          <p className="mt-1 text-xs text-kairikos-muted">
            Mínimo 8 caracteres. Combina letras, números y símbolos para una contraseña más segura.
          </p>
        )}
      </div>

      <div>
        <label htmlFor={confirmId} className="label">
          Confirma la nueva contraseña
        </label>
        <input
          id={confirmId}
          name="confirmPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          aria-invalid={Boolean(fieldErrors.confirmPassword) || undefined}
          aria-describedby={
            fieldErrors.confirmPassword ? `${confirmId}-error` : undefined
          }
          data-testid="password-confirm"
        />
        {fieldErrors.confirmPassword ? (
          <p id={`${confirmId}-error`} className="mt-1 text-xs text-kairikos-danger">
            {fieldErrors.confirmPassword}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="submit"
          className="btn-primary w-full sm:w-auto"
          data-testid="password-submit"
          disabled={isSaving || !dirty}
        >
          {isSaving ? 'Actualizando…' : 'Cambiar contraseña'}
        </button>
      </div>

      <div role="status" aria-live="polite" className="min-h-[1.5rem] text-sm">
        {state.kind === 'success' ? (
          <p
            className="rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-kairikos-success"
            data-testid="password-status"
            data-status-kind="success"
          >
            {state.message}
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <p
            id={errorId}
            className="rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-kairikos-danger"
            data-testid="password-status"
            data-status-kind="error"
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function mapPasswordError(status: number, code: string | undefined): string {
  switch (code) {
    case 'invalid_current_password':
      return 'La contraseña actual no es correcta.';
    case 'must_complete_setup':
      return 'Primero tienes que crear tu contraseña desde el enlace de bienvenida.';
    case 'too_many_requests':
      return 'Has hecho demasiados intentos. Espera unos minutos antes de volver a intentarlo.';
    case 'service_unavailable':
      return 'El servicio no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.';
    case 'user_not_found':
      return 'No hemos encontrado tu cuenta. Escríbenos a hola@kairikos.com.';
    case 'invalid_body':
      return 'Revisa los datos: la nueva contraseña debe tener al menos 8 caracteres.';
    default:
      if (status === 401) return 'La contraseña actual no es correcta.';
      if (status === 429) return 'Has hecho demasiados intentos. Espera unos minutos.';
      if (status >= 500)
        return 'El servicio no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.';
      return 'No hemos podido actualizar la contraseña. Inténtalo de nuevo en unos minutos.';
  }
}
