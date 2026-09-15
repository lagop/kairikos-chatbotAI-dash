// =============================================================================
// Fase 5a — service worker del portal.
//
// ESTE FICHERO NO CACHEA NADA, Y ESO ES TODO EL DISEÑO.
//
// Existe por una sola razón: Chrome no ofrece instalar una PWA si no hay
// un service worker con un manejador de `fetch`. Eso es lo que hace, y
// deliberadamente nada más.
//
// POR QUÉ NO CACHEA
//
// Esto es un panel de datos: llamadas perdidas de hoy, presupuestos
// abiertos, avisos pendientes. Un service worker que sirva una copia
// guardada le enseña al dueño de un negocio una llamada que ya devolvió
// o le esconde una que acaba de entrar. En un blog, caché agresiva es
// velocidad; aquí es mentir.
//
// Y hay un riesgo peor que el dato viejo: un service worker mal hecho
// se cachea A SÍ MISMO y a la carcasa de la aplicación, y entonces el
// usuario se queda clavado en una versión antigua que NO se arregla
// desplegando —hay que pasar por el ciclo de actualización del propio
// worker—. Es de los pocos fallos de frontend que sobreviven a un
// despliegue correcto, y no compensa para ganar unos milisegundos.
//
// `fetch` va a la red y punto. Si no hay red, falla como fallaría sin
// service worker: el navegador enseña su propia página de sin conexión,
// que el usuario ya reconoce.
//
// SI ALGÚN DÍA SE QUIERE CACHÉ DE VERDAD
//
// El sitio es este fichero, y la regla es: solo recursos con hash en el
// nombre (/_next/static/**), nunca HTML, nunca /api/**. Todo lo demás
// tiene que seguir yendo a la red.
//
// EL INTERRUPTOR DE EMERGENCIA
//
// `skipWaiting` + `clients.claim` hacen que una versión nueva de ESTE
// fichero sustituya a la anterior en cuanto se descarga, sin esperar a
// que el usuario cierre todas las pestañas. Es lo que convierte un
// service worker roto en un problema de un despliegue en vez de uno
// permanente: si hubiera que desactivarlo, basta con publicar aquí un
// worker que llame a `self.registration.unregister()`.
// =============================================================================

self.addEventListener('install', () => {
  // Nada que precargar. Activa inmediatamente en vez de quedarse esperando
  // a que se cierren las pestañas de la versión anterior.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Limpieza defensiva: si una versión futura llegara a crear cachés
      // y luego se revirtiera, esto las borra en lugar de dejarlas
      // sirviendo contenido viejo para siempre.
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// El manejador que Chrome exige para considerar la app instalable.
// Pasa todo a la red sin tocarlo — ver la cabecera.
self.addEventListener('fetch', () => {
  // Sin event.respondWith(): el navegador sigue su camino normal. Es
  // deliberado y no un olvido — llamar a respondWith(fetch(event.request))
  // haría lo mismo pero pasando cada petición por el worker sin motivo.
});
