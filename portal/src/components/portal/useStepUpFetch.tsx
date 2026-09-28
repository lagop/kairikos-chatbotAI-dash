'use client';

import { useCallback, useState } from 'react';
import { TotpStepUpModal } from '@/components/portal/TotpStepUpModal';

/**
 * `fetch` para acciones del admin que pueden pedir TOTP reciente (ver
 * src/lib/operator-totp-stepup.ts). Si la ruta responde
 * 403 `totp_step_up_required`, abre el modal del código y, cuando se
 * verifica, repite la misma petición una vez. Si se cancela, devuelve la
 * respuesta 403 original y quien llama la trata como cualquier error.
 *
 * Uso: `const { stepUpFetch, stepUpModal } = useStepUpFetch();`, cambiar
 * `fetch(...)` por `stepUpFetch(...)` y pintar `{stepUpModal}`.
 */
export function useStepUpFetch() {
  const [pending, setPending] = useState<null | { resolve: (verified: boolean) => void }>(null);

  const stepUpFetch = useCallback(async (input: string, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    if (res.status !== 403) return res;
    const body = (await res.clone().json().catch(() => null)) as { error?: string } | null;
    if (body?.error !== 'totp_step_up_required') return res;
    const verified = await new Promise<boolean>((resolve) => setPending({ resolve }));
    setPending(null);
    return verified ? fetch(input, init) : res;
  }, []);

  const stepUpModal = pending ? (
    <TotpStepUpModal onCancel={() => pending.resolve(false)} onVerified={() => pending.resolve(true)} />
  ) : null;

  return { stepUpFetch, stepUpModal };
}
