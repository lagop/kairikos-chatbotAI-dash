// =============================================================================
// Fase 5d — push lo más cerca del extremo a extremo que se puede sin red.
//
// Se intentó una prueba real en navegador: el navegador embebido del
// entorno de desarrollo DENIEGA el permiso de notificaciones de forma
// automática, así que no hay suscripción real que obtener. Esto cubre las
// dos mitades que sí se pueden ejecutar de verdad:
//
//   1. EL CIFRADO Y LA FIRMA, con la librería real y claves reales: que
//      con nuestra configuración VAPID se genera una petición válida
//      —cifrada con aes128gcm y firmada con un JWT ES256— para una
//      suscripción con claves de navegador reales. Sin mocks.
//   2. EL MANEJADOR DEL SERVICE WORKER, ejecutando el `public/sw.js` real
//      dentro de un sandbox de `vm` con un `self` simulado, y disparándole
//      eventos push y de clic.
//
// Lo que queda sin probar, y hay que decirlo: el salto de red al servicio
// push del navegador y el pintado de la notificación por el sistema
// operativo. Eso solo se ve con un móvil en la mano.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import webpush from 'web-push';

describe('cifrado y firma VAPID reales', () => {
  // Un par VAPID y unas claves de "navegador" de verdad, generadas aquí.
  const vapid = webpush.generateVAPIDKeys();
  const browser = createECDH('prime256v1');
  browser.generateKeys();

  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/prueba-sin-red',
    keys: {
      p256dh: browser.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };

  const details = webpush.generateRequestDetails(
    subscription,
    JSON.stringify({ title: 'Nueva llamada perdida', body: 'Te han dejado un recado.', url: '/portal/llamadas' }),
    {
      vapidDetails: { subject: 'mailto:avisos@kairikos.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 3600,
      urgency: 'high',
    },
  );

  it('va al endpoint del navegador por POST', () => {
    expect(details.method).toBe('POST');
    expect(details.endpoint).toBe(subscription.endpoint);
  });

  it('lleva el cuerpo cifrado con aes128gcm, no el texto en claro', () => {
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    const body = details.body as Buffer;
    expect(body.length).toBeGreaterThan(0);
    // El texto no puede aparecer en el cuerpo cifrado.
    expect(body.toString('utf8')).not.toContain('llamada perdida');
  });

  it('va firmado con un JWT VAPID que lleva nuestra clave pública', () => {
    const auth = String(details.headers.Authorization);
    expect(auth).toMatch(/^vapid t=.+, k=.+$/);
    expect(auth).toContain(`k=${vapid.publicKey}`);

    // El JWT declara ES256 y apunta al origen del servicio push.
    const jwt = auth.match(/t=([^,]+)/)![1];
    const [header, payload] = jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()));
    expect(header.alg).toBe('ES256');
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('mailto:avisos@kairikos.com');
  });

  it('respeta el TTL y la urgencia que pedimos', () => {
    expect(details.headers.TTL).toBe(3600);
    expect(details.headers.Urgency).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// El service worker real, en un sandbox
// ---------------------------------------------------------------------------

function loadServiceWorker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let openWindows: Array<{ url: string }> = [];

  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        openWindows.map((w) => ({
          url: w.url,
          focus: async () => focused.push(w.url),
          navigate: async (u: string) => opened.push(`navigate:${u}`),
        })),
      openWindow: async (u: string) => opened.push(`open:${u}`),
    },
  };

  const code = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
  vm.runInNewContext(code, { self, caches: { keys: async () => [], delete: async () => true }, URL });

  /** Dispara un evento y espera lo que el worker pase a waitUntil. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };

  return {
    handlers,
    shown,
    opened,
    focused,
    setOpenWindows: (w: Array<{ url: string }>) => (openWindows = w),
    dispatch,
  };
}

const pushEvent = (payload: unknown) => ({
  data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) },
});

describe('el manejador push del service worker', () => {
  it('registra los manejadores de push y de clic', () => {
    const sw = loadServiceWorker();
    expect(typeof sw.handlers.push).toBe('function');
    expect(typeof sw.handlers.notificationclick).toBe('function');
  });

  it('enseña la notificación con el título, el cuerpo y el tag del servidor', async () => {
    const sw = loadServiceWorker();
    await sw.dispatch('push', pushEvent({ title: 'Nueva llamada perdida', body: 'Te han dejado un recado.', url: '/portal/llamadas', tag: 'missed-calls' }));

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe('Nueva llamada perdida');
    expect(sw.shown[0].options).toMatchObject({
      body: 'Te han dejado un recado.',
      tag: 'missed-calls',
      data: { url: '/portal/llamadas' },
    });
  });

  // La última barrera antes de abrir una URL.
  it('NO acepta una URL de fuera del portal aunque llegue en el payload', async () => {
    const sw = loadServiceWorker();
    await sw.dispatch('push', pushEvent({ title: 'x', body: 'y', url: 'https://evil.example/login' }));
    expect((sw.shown[0].options.data as { url: string }).url).toBe('/portal');
  });

  // Chrome penaliza a los sitios que reciben un push y no enseñan nada.
  it('un payload ilegible enseña un aviso genérico en vez de nada', async () => {
    const sw = loadServiceWorker();
    await sw.dispatch('push', { data: { json: () => { throw new Error('no es json'); } } });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe('Kairikos');
  });

  it('al tocarla con el portal ya abierto, enfoca esa ventana en vez de abrir otra', async () => {
    const sw = loadServiceWorker();
    sw.setOpenWindows([{ url: 'http://localhost:3003/portal/asistente' }]);
    await sw.dispatch('notificationclick', {
      notification: { close: () => undefined, data: { url: '/portal/llamadas' } },
    });
    expect(sw.focused).toHaveLength(1);
    expect(sw.opened).toEqual(['navigate:/portal/llamadas']);
  });

  it('al tocarla sin el portal abierto, abre una ventana nueva', async () => {
    const sw = loadServiceWorker();
    sw.setOpenWindows([]);
    await sw.dispatch('notificationclick', {
      notification: { close: () => undefined, data: { url: '/portal/llamadas' } },
    });
    expect(sw.opened).toEqual(['open:/portal/llamadas']);
  });
});
