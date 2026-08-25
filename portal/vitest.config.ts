import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // `server-only` is not an installed package: Next aliases the bare
      // specifier to its own vendored stub during the server build, so the
      // ten `src/lib/*` modules that import it resolve fine under `next
      // build` but fail to collect under vitest. Point the resolver at the
      // same empty stub Next uses on the server side.
      'server-only': path.resolve(
        __dirname,
        'node_modules/next/dist/compiled/server-only/empty.js',
      ),
    },
  },
  // tsconfig.json sets `jsx: 'preserve'` because Next transforms JSX
  // itself, and Vite's transformer honours that — so a .tsx module
  // reached vitest with its JSX untransformed and failed to parse. That
  // is why no test in this repo could import a page or a component.
  // Transform it here instead; files without JSX are unaffected.
  //
  // `oxc`, not `esbuild`: Vite 8 transforms with oxc, and the esbuild
  // key is silently ignored.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // next-auth@beta (5.0.0-beta) reaches into `next/server` via a bare
    // specifier that the Next 14 package.json#exports field gates behind
    // a `server` condition vitest's resolver does not honor by default.
    // Inline `next-auth` so its `import "next/server"` is resolved against
    // the real `next` install instead of the bare spec.
    server: {
      deps: {
        inline: ['next-auth', '@auth/prisma-adapter'],
      },
    },
  },
});
