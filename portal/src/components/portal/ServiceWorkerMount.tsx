'use client';

import { useEffect } from 'react';

// =============================================================================
// Fase 5a — registra el service worker que hace instalable el portal.
//
// ÁMBITO `/portal`, AUNQUE EL FICHERO VIVA EN LA RAÍZ. Un service worker
// puede registrarse con un ámbito MÁS ESTRECHO que su propia ubicación,
// nunca más ancho. `/sw.js` podría controlar el sitio entero; se le acota
// a mano para que no toque `/admin` ni las páginas públicas.
//
// Se monta en el layout de `/portal` y no en el raíz por lo mismo: el
// panel de operador y la página de login no forman parte de la app que el
// cliente instala.
//
// SE REGISTRA DESPUÉS DE `load` a propósito. Durante la carga inicial, la
// descarga del worker compite por ancho de banda con lo que el usuario
// está esperando ver. No hay ninguna prisa: la instalación es una
// decisión que tomará más tarde, y el worker no cachea nada que haga
// falta ya.
//
// NO RENDERIZA NADA. La invitación a instalar es otra cosa y vive en
// InstallPrompt.tsx, porque solo aparece donde hay motivo diario para
// instalar — no en todo el portal.
// =============================================================================

export function ServiceWorkerMount() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/portal' }).catch(() => {
        // Silencioso a propósito. Un registro fallido significa que el
        // portal no será instalable en ese navegador; NO significa que
        // haya que molestar al usuario con un error sobre una función
        // que probablemente ni ha pedido. Se sigue navegando igual.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register);
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
