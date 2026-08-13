const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
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
    serverComponentsExternalPackages: ['resend', '@node-rs/argon2', '@node-rs/argon2-linux-x64-gnu'],
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
