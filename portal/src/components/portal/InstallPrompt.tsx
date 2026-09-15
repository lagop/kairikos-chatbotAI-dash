'use client';

import { useEffect, useState } from 'react';

// =============================================================================
// Fase 5a — la invitación a instalar el portal en el móvil.
//
// NO APARECE EN TODO EL PORTAL, Y ESO ES LA DECISIÓN. Nadie instala una
// aplicación para leer un informe de SEO una vez al mes. Se monta solo
// donde hay un motivo diario para tenerla a mano — hoy, la página de
// llamadas perdidas.
//
// Instalar tiene un coste de adopción real; gastarlo donde no hay uso
// diario no solo no convierte, además quema el gesto: quien dice "ahora
// no" una vez ya no lo vuelve a mirar.
//
// POR QUÉ DOS CAMINOS DISTINTOS
//
// Android/Chrome dispara `beforeinstallprompt`, que se puede guardar y
// lanzar con un botón. Safari en iOS NO lo implementa — allí instalar es
// Compartir → Añadir a pantalla de inicio, y no existe API para pedirlo.
// Lo único que se puede hacer en iOS es explicar el gesto, así que eso se
// hace: instrucciones, no un botón que no haría nada.
//
// Y en iOS importa más que en Android, aunque sea el que peor lo pone:
// Safari solo permite notificaciones push desde una PWA ya instalada.
// Sin este paso, en iPhone las notificaciones no existen.
//
// SE CALLA CUANDO YA ESTÁ INSTALADA (display-mode: standalone) y cuando
// el usuario la ha rechazado — ver DISMISS_KEY.
// =============================================================================

/** Rechazada por el usuario. En localStorage y no en la base de datos: es
 *  una preferencia de ESTE dispositivo. Alguien puede querer el portal
 *  instalado en el móvil y no en el portátil, y eso no es una
 *  contradicción que haya que resolver en el servidor. */
const DISMISS_KEY = 'kairikos-install-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // El segundo es el de iOS, que nunca implementó el display-mode.
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true); // hasta comprobarlo, callado

  useEffect(() => {
    if (isStandalone()) return;

    let stored: string | null = null;
    try {
      stored = localStorage.getItem(DISMISS_KEY);
    } catch {
      // Navegación privada o almacenamiento bloqueado. Se trata como "no
      // rechazado": preferimos ofrecerlo de más que no ofrecerlo nunca.
    }
    if (stored) return;

    setDismissed(false);

    // iOS no dispara el evento, así que allí se decide por el user agent.
    if (isIos()) {
      setShowIosHint(true);
      return;
    }

    const onPrompt = (event: Event) => {
      // Sin esto, Chrome enseña su propio banner donde quiera. Se
      // intercepta para poder ofrecerlo en el momento y el sitio que
      // tienen sentido.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Si no se puede recordar, volverá a aparecer. Molesto, no roto.
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // Se acepte o no, el evento ya está gastado: Chrome no lo vuelve a
    // entregar en esta sesión. Se oculta en ambos casos — insistir tras
    // un "no" es exactamente lo que hace que se ignore el siguiente.
    setDeferred(null);
    dismiss();
  };

  if (dismissed) return null;
  if (!deferred && !showIosHint) return null;

  return (
    <div className="card space-y-3" data-testid="install-prompt">
      <div>
        <h3 className="text-sm font-semibold">Ten esto a mano en el móvil</h3>
        <p className="mt-1 text-sm text-kairikos-muted">
          {showIosHint
            ? 'Pulsa Compartir y luego «Añadir a pantalla de inicio» para abrirlo de un toque, sin buscar la pestaña.'
            : 'Instálalo y lo abres de un toque, como cualquier otra aplicación.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {deferred ? (
          <button type="button" className="btn-primary" onClick={install} data-testid="install-prompt-accept">
            Instalar
          </button>
        ) : null}
        <button
          type="button"
          className="text-sm text-kairikos-muted underline"
          onClick={dismiss}
          data-testid="install-prompt-dismiss"
        >
          Ahora no
        </button>
      </div>
    </div>
  );
}
