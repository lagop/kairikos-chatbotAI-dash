import { defineConfig } from 'vitest/config';
import path from 'path';

// =============================================================================
// Las pruebas que hablan con servidores de verdad.
//
// Config aparte, y no un directorio más dentro de vitest.config.ts, para que
// `npx vitest run` siga siendo lo que es: rápido, sin red y ejecutable en CI.
// Estas necesitan algo levantado al otro lado y se saltan solas si no lo hay,
// pero aun así no tienen sitio en la suite de siempre: una prueba que a veces
// se salta y a veces tarda un minuto enseña a desconfiar del verde.
//
//   npx vitest run --config vitest.real.config.ts
//
// Cada archivo de tests/real/ documenta en su cabecera qué hace falta
// levantar y con qué variables de entorno.
// =============================================================================

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Mismo apaño que en vitest.config.ts: `server-only` no es un paquete
      // instalado, Next lo sustituye por un stub vacío en el build de
      // servidor.
      'server-only': path.resolve(__dirname, 'node_modules/next/dist/compiled/server-only/empty.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/real/**/*.test.ts'],
    // Una conexión SFTP a un servidor saturado tarda; el corte real lo pone
    // el readyTimeout de la propia función, no vitest.
    testTimeout: 60000,
  },
});
