'use client';

import { useTransition } from 'react';
import { logoutAction } from '@/app/portal/perfil/actions';

// KAIA-3921 — accessible logout trigger. Uses `useTransition` so the
// button shows a pending state during the server-action round-trip.
// The action itself terminates with `redirect('/portal/login')`, so
// the click never has to navigate client-side.
export function LogoutButton({
  className = 'btn-ghost w-full justify-center sm:w-auto',
  label = 'Cerrar sesión',
  pendingLabel = 'Cerrando sesión…',
  testId = 'profile-logout',
}: {
  className?: string;
  label?: string;
  pendingLabel?: string;
  testId?: string;
}) {
  const [isPending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(() => {
      void logoutAction();
    });
  };

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={isPending}
      aria-busy={isPending || undefined}
      data-testid={testId}
    >
      {isPending ? pendingLabel : label}
    </button>
  );
}
