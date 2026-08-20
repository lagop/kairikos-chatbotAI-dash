'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { step8Schema, type Step8Input } from '@/lib/wizard-schemas';

interface Props {
  value: Step8Input | null;
  onChange: (value: Step8Input) => void;
}

// =============================================================================
// WP: conexión de canales — Fase 6. Este paso deja de ser un formulario
// (los dos booleanos "canal_web"/"canal_whatsapp" nunca reflejaron una
// conexión real — ver el WP de conexión de canales completo) y pasa a
// ser informativo: la conexión real vive en /portal/canales, mismo
// criterio que Reseñas, que tampoco vive dentro del wizard.
//
// Deliberadamente NO se muestra el estado en vivo de los canales acá —
// duplicar esa lectura en dos lugares es exactamente el patrón que ya
// causó una divergencia real en este código (WP-17: /portal y
// /portal/status computaban el mismo dato dos veces y terminaron
// mostrando números distintos al mismo tiempo). /portal/canales es la
// única fuente de verdad; este paso solo enlaza ahí.
//
// step8Schema y el emit-on-mount de abajo se mantienen sin cambios para
// no tocar la máquina de estados del wizard (borrador/enviado/aprobado)
// — un valor por defecto válido sigue disponible para que "Guardar y
// continuar" funcione igual que en cualquier otro paso, aunque este ya
// no tenga nada que el cliente edite.
//
// El valor inicial que llega acá para un cliente sin envío previo de
// este paso es `{}` (objeto vacío) — no `null` — porque
// resolveClientStep() en wizard-visibility.ts hace
// `{ ...def.defaultPayload }` cuando no hay guardado, y el catálogo de
// Step 8 tiene `defaultPayload: NO_DEFAULT = {}`. Por eso NO alcanza con
// chequear si `value` es truthy — `{}` lo es — hay que validar contra
// el schema real: solo se deja el valor como está si YA es válido.
// =============================================================================

const DEFAULT_VALUE: Step8Input = { canal_web: true, canal_whatsapp: false };

export function Step8Canales({ value, onChange }: Props) {
  useEffect(() => {
    if (step8Schema.safeParse(value ?? {}).success) return;
    const parsed = step8Schema.safeParse(DEFAULT_VALUE);
    if (parsed.success) onChange(parsed.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-sm text-kairikos-muted">
        La conexión de canales ahora se gestiona desde su propia sección del portal — ahí puedes conectar Telegram,
        WhatsApp, Messenger, Instagram y el widget para tu web, y ver el estado real de cada uno.
      </p>
      <Link href="/portal/canales" className="btn-primary" data-testid="step8-canales-link">
        Ir a Canales →
      </Link>
    </div>
  );
}
