import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

// =============================================================================
// Fase 5a — el manifest que hace instalable el portal.
//
// EL ALCANCE ES `/portal`, Y ESA ES LA DECISIÓN QUE HAY QUE ENTENDER.
//
// Se consideró acotarlo al producto de llamadas, que es el único con uso
// diario hoy. Se descartó por tres motivos:
//
//   1. El portal YA es una sola aplicación — un layout, una navegación con
//      los siete productos. Recortar un trozo instalable de una carcasa
//      unificada es más trabajo, no menos.
//   2. Un cliente con varios productos quiere UNA app, no tres.
//   3. `scope` y `start_url` son de las pocas cosas de una PWA caras de
//      revertir: ampliarlas después puede leerse como otra aplicación
//      distinta y deja las instalaciones existentes en un estado
//      inconsistente. Se decide una vez y se decide ancho.
//
// NO INCLUYE `/admin`. El panel de operador es nuestro, se usa desde un
// escritorio, y meterlo dentro del alcance haría que al instalar "tu
// portal" el cliente arrastrara rutas que no son suyas.
//
// `display: standalone` y no `fullscreen`: esto es un panel de datos que
// se consulta, no un juego. Quitarle al usuario la barra de estado del
// móvil —hora y batería— para ganar treinta píxeles es mal negocio.
// =============================================================================

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Portal Kairikos',
    // Lo que cabe debajo del icono en la pantalla de inicio. Doce
    // caracteres es donde Android empieza a poner puntos suspensivos.
    short_name: 'Kairikos',
    description:
      'Tus llamadas recuperadas, tus clientes y tus avisos, en el móvil.',
    start_url: '/portal',
    scope: '/portal',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'es',
    // Mismo valor que el `themeColor` del layout raíz: la barra del
    // sistema y la de la app tienen que coincidir o se ve una costura.
    theme_color: '#F3F4FA',
    background_color: '#F3F4FA',
    categories: ['business', 'productivity'],
    // PNG estáticos, generados por scripts/generate-icons.mjs — ver su
    // cabecera para por qué no se usa ImageResponse de next/og, que sería
    // lo idiomático (revienta el build en Windows).
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        // `maskable` es lo que evita que Android recorte el icono dentro
        // de su propia forma y se coma el borde. Es el mismo fichero: el
        // generador ya deja la marca dentro del 80% central garantizado.
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
