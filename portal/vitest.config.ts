import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
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
