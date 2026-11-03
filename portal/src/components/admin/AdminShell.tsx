'use client';

import { useState, type ReactNode } from 'react';
import { AdminSidebar } from '@/components/admin/AdminSidebar';
import { ADMIN_SIDEBAR_COOKIE } from '@/lib/admin-nav';

// 03/11/2026 — la barra y el contenido comparten el estado «contraída»:
// contraída, el contenido deja de estar limitado a max-w-page (960 px) y
// usa el ancho entero, que es para lo que se contrae (tablas de clientes,
// leads, métricas). El estado inicial lo lee el layout de la cookie.
export function AdminShell({ initialMini, children }: { initialMini: boolean; children: ReactNode }) {
  const [mini, setMini] = useState(initialMini);

  function toggleMini() {
    const next = !mini;
    setMini(next);
    // Un año, solo para el panel. Si el navegador no guarda cookies, la
    // barra funciona igual: vuelve a salir ancha en la próxima carga.
    document.cookie = `${ADMIN_SIDEBAR_COOKIE}=${next ? 'mini' : 'ancha'}; path=/admin; max-age=31536000; samesite=lax`;
  }

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <AdminSidebar mini={mini} onToggleMini={toggleMini} />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className={`mx-auto w-full flex-1 px-4 py-6 sm:px-6 sm:py-8 ${mini ? 'lg:max-w-none lg:px-8' : 'max-w-page'}`}>{children}</main>
      </div>
    </div>
  );
}
