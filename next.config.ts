import type { NextConfig } from 'next';

/**
 * AragonRouter Next.js configuration.
 *
 * Only two concerns live here:
 *  - send the site root to the console (the product has no marketing page);
 *  - keep the proxy routes on the Node.js runtime so `node:sqlite` is available.
 *
 * No environment variables are read at build time: every secret is resolved at
 * request time in `src/lib/env.ts` so that `next build` never needs real
 * credentials.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: '/',
        destination: '/console',
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        // The console and the admin API are never embedded and never sniffed.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
