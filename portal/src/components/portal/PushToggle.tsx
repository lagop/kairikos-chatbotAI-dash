'use client';

import { useEffect, useState } from 'react';

// =============================================================================
// Fase 5d — activar los avisos en este dispositivo.
//
// EL PERMISO SE PIDE AL PULSAR, NUNCA AL CARGAR LA PÁGINA. Los navegadores
// castigan a los sitios que piden permiso de notificaciones sin un gesto
// del usuario —Chrome silencia el diálogo y lo marca como molesto— y un
// "no" dado a un diálogo que aparece solo es prácticamente irreversible:
// volver a activarlo exige que el usuario encuentre el ajuste escondido en
// la configuración del navegador. Se gasta una sola oportunidad, así que
// se gasta cuando ya ha dicho que lo quiere.
//
// iOS: SOLO FUNCIONA CON LA APP INSTALADA. Safari no ofrece push a una
// pestaña, solo a una PWA añadida a la pantalla de inicio. En un iPhone
// sin instalar, este componente no enseña un botón que no funcionaría:
// explica que primero hay que instalarla.
//
// SI PUSH NO ESTÁ CONFIGURADO EN EL SERVIDOR (sin claves VAPID), no se
// pinta nada. Ofrecer activar algo que no puede llegar a funcionar es peor
// que no ofrecerlo.
// =============================================================================

type Status = 'loading' | 'hidden' | 'needs-install' | 'denied' | 'off' | 'on' | 'working';

/** La clave VAPID llega en base64url; pushManager.subscribe la quiere en
 *  binario. Devuelve un ArrayBuffer y no el Uint8Array directamente porque
 *  los tipos de TypeScript recientes distinguen ArrayBuffer de
 *  SharedArrayBuffer y la firma de subscribe solo acepta el primero. */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function PushToggle() {
  const [status, setStatus] = useState<Status>('loading');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        // iOS antes de instalar no expone PushManager: se distingue del
        // navegador que simplemente no lo soporta.
        const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
        setStatus(ios && !isStandalone() ? 'needs-install' : 'hidden');
        return;
      }

      const res = await fetch('/api/portal/push/subscription').catch(() => null);
      if (!res?.ok) return setStatus('hidden');
      const info = (await res.json()) as { available: boolean; publicKey: string | null };
      if (!info.available || !info.publicKey) return setStatus('hidden');
      setPublicKey(info.publicKey);

      if (Notification.permission === 'denied') return setStatus('denied');

      const reg = await navigator.serviceWorker.getRegistration('/portal');
      const existing = await reg?.pushManager.getSubscription();
      setStatus(existing ? 'on' : 'off');
    })().catch(() => setStatus('hidden'));
  }, []);

  const enable = async () => {
    if (!publicKey) return;
    setStatus('working');
    setError(null);
    try {
      // AQUÍ, dentro del gesto, y no antes. Ver la cabecera.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off');
        return;
      }

      const reg = await navigator.serviceWorker.getRegistration('/portal');
      if (!reg) throw new Error('no_service_worker');

      const subscription = await reg.pushManager.subscribe({
        // Obligatorio en Chrome: cada push tiene que acabar en una
        // notificación visible. No se pueden mandar pushes silenciosos.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(publicKey),
      });

      const res = await fetch('/api/portal/push/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) {
        // Si el servidor no la guardó, se deshace también en el navegador:
        // una suscripción que existe en el móvil pero no en la base haría
        // creer al usuario que tiene los avisos activos.
        await subscription.unsubscribe().catch(() => null);
        throw new Error('save_failed');
      }
      setStatus('on');
    } catch {
      setError('No se han podido activar los avisos. Inténtalo de nuevo.');
      setStatus('off');
    }
  };

  const disable = async () => {
    setStatus('working');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/portal');
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) {
        await fetch('/api/portal/push/subscription', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => null);
        await subscription.unsubscribe();
      }
      setStatus('off');
    } catch {
      setStatus('on');
    }
  };

  if (status === 'loading' || status === 'hidden') return null;

  return (
    <div className="card space-y-3" data-testid="push-toggle" data-status={status}>
      <div>
        <h3 className="text-sm font-semibold">Avisos en este dispositivo</h3>
        <p className="mt-1 text-sm text-kairikos-muted">
          {status === 'needs-install'
            ? 'En iPhone, los avisos solo funcionan con el portal instalado. Añádelo a tu pantalla de inicio y actívalos desde ahí.'
            : status === 'denied'
              ? 'Tienes los avisos bloqueados para este sitio. Para activarlos, cámbialo en los ajustes de tu navegador.'
              : status === 'on'
                ? 'Te avisaremos aquí en cuanto entre una llamada perdida.'
                : 'Recibe un aviso en cuanto entre una llamada perdida, sin tener que abrir WhatsApp.'}
        </p>
      </div>

      {status === 'off' || status === 'working' ? (
        <button
          type="button"
          className="btn-primary"
          onClick={enable}
          disabled={status === 'working'}
          data-testid="push-toggle-enable"
        >
          {status === 'working' ? 'Activando…' : 'Activar avisos'}
        </button>
      ) : null}

      {status === 'on' ? (
        <button type="button" className="text-sm text-kairikos-muted underline" onClick={disable} data-testid="push-toggle-disable">
          Desactivar en este dispositivo
        </button>
      ) : null}

      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
