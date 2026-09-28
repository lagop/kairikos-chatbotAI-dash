const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Revisión de seguridad 22/09/2026 — el portal no usa next/image, pero el
  // endpoint /_next/image existe igual y es donde se concentran varios avisos
  // de Next 14 sin arreglo en la rama 14.x (DoS del optimizador y de su caché
  // en disco). Apagarlo no cambia nada visible y quita esa superficie.
  images: { unoptimized: true },
  // Revisión de seguridad 22/09/2026 — cabeceras que faltaban (Traefik ya
  // pone HSTS, nosniff y X-Frame-Options: DENY; ver docker-compose.yml).
  //
  // La CSP es de base A PROPÓSITO: no restringe script-src. Next 14 mete
  // scripts inline propios (hidratación, y el THEME_INIT_SCRIPT de
  // layout.tsx), así que una script-src estricta exige nonces por petición,
  // y los nonces de CSP en la rama 14.x tienen un aviso de XSS sin arreglo
  // (GHSA-ffhc-5mcf-pf4q). Esa parte va con la migración a Next 15. Lo que
  // sí se cierra ya: que otra web meta el portal en un iframe, que un
  // <base> inyectado redirija las rutas relativas, y los plugins.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests",
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@': path.resolve(__dirname, 'src'),
    };
    return config;
  },
  experimental: {
    // KAIA-2858 — `@node-rs/argon2` ships a N-API `.node` binary in a
    // platform-specific sub-package (`@node-rs/argon2-linux-x64-gnu`).
    // Without this entry, webpack tries to parse the `.node` file as JS
    // and the build fails with "Module parse failed: Unexpected character".
    // Listing it as external makes Next.js leave it as a runtime require()
    // so Vercel's Lambda resolves the N-API binary from node_modules at
    // cold start.
    //
    // Producto Web, Fase 1 — ssh2 (bajo ssh2-sftp-client, con el que se
    // publica la web del cliente) tiene exactamente el mismo problema: trae
    // sshcrypto.node y el build muere con el mismo mensaje. Va en ESTA lista
    // y no en un segundo bloque 'experimental', que pisaría este entero.
    // Encontrado en CI, no en local: 'next dev' no empaqueta el servidor
    // igual que 'next build'.
    serverComponentsExternalPackages: [
      'resend',
      '@node-rs/argon2',
      '@node-rs/argon2-linux-x64-gnu',
      'ssh2',
      'ssh2-sftp-client',
    ],
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/portal',
        permanent: false,
      },
      // WP-16 — the client wizard's URLs used to be implicitly chatbot's
      // (no product in the path). Now that /portal/wizard/[product] and
      // /api/portal/wizard/[product] are real App Router segments, a
      // sibling /portal/wizard/[step] folder using a DIFFERENT dynamic
      // param name would conflict with [product] (Next.js requires every
      // dynamic segment at the same route level to share one param name).
      // These framework-level redirects are the compat shim instead:
      // config-level rewrites run before route-tree resolution, so they
      // sidestep the naming conflict entirely. The `(\\d{1,2})` regex
      // constraint is what keeps a real product code like `chatbot` or
      // `web` from ever matching — old wizard steps are always "1".."12".
      // `permanent: true` emits a 308, which (unlike 301/302) preserves
      // the request method and body — required for the wizard's PATCH
      // autosave/submit calls, whose callers must keep working unchanged.
      {
        source: '/api/portal/wizard/steps',
        destination: '/api/portal/wizard/chatbot/steps',
        permanent: true,
      },
      {
        source: '/api/portal/wizard/:step(\\d{1,2})',
        destination: '/api/portal/wizard/chatbot/:step',
        permanent: true,
      },
      {
        source: '/portal/wizard/:step(\\d{1,2})',
        destination: '/portal/wizard/chatbot/:step',
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
