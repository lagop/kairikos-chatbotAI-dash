'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// =============================================================================
// Portada del portal → «Nuevo: elige en qué webs funciona tu chat»
// (21/11/2026). Desde #408 cada cliente puede limitar su widget a sus webs en
// Canales → Web, pero no lo sabe nadie que no entre ahí.
//
// Quién lo ve lo decide el servidor (findWidgetWithoutAllowedOrigins): solo
// con el widget web activo y la lista vacía. Por eso el aviso no necesita
// fecha de caducidad: deja de salir solo en cuanto el cliente guarda una web.
//
// La ✕ se recuerda en localStorage, como en InstallPrompt: es una preferencia
// de este dispositivo, no un dato que haya que guardar en el servidor. La
// clave lleva el cliente porque un mismo navegador puede entrar con varios.
// =============================================================================

export function WidgetOriginsNotice({ clientId, href }: { clientId: string; href: string }) {
  const dismissKey = `kairikos-aviso-webs-widget:${clientId}`;
  // Hasta leer localStorage, callado: así no parpadea para quien ya lo cerró.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(dismissKey);
    } catch {
      // Almacenamiento bloqueado: se enseña. Si no se puede recordar la ✕,
      // volverá a salir, que es molesto pero no roto.
    }
    if (!stored) setVisible(true);
  }, [dismissKey]);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(dismissKey, '1');
    } catch {
      // Ver arriba.
    }
  };

  if (!visible) return null;

  return (
    <div
      className="flex items-start justify-between gap-3 rounded-xl border border-kairikos-accent2/30 bg-kairikos-accent2/5 px-4 py-3 text-sm text-kairikos-text"
      role="status"
      data-testid="widget-origins-notice"
    >
      <div>
        <p className="font-semibold">Nuevo: elige en qué webs funciona tu chat</p>
        <p className="mt-1 text-kairikos-muted">
          El código del chat que pegaste en tu web lo puede ver cualquiera. Si alguien lo copia en otra página, el chat
          contestaría también allí y gastaría tus mensajes del mes. Pon tus webs en la lista y solo funcionará en ellas.
        </p>
        <Link
          href={href}
          className="mt-2 inline-flex items-center gap-2 text-sm text-kairikos-accent2 hover:underline"
          data-testid="widget-origins-notice-link"
        >
          Elegir mis webs →
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded px-1 text-lg leading-none text-kairikos-muted hover:text-kairikos-text"
        aria-label="Cerrar aviso"
        data-testid="widget-origins-notice-dismiss"
      >
        ×
      </button>
    </div>
  );
}
