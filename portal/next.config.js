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
    ];
  },
};

module.exports = nextConfig;
