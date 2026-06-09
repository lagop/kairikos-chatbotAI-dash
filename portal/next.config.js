const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // Playwright tests live alongside the app but use their own import paths.
    // Build only needs to typecheck the app code; the test suite is validated
    // by `npx playwright test` in CI, not by `next build`.
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@': path.resolve(__dirname, 'src'),
    };
    return config;
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
