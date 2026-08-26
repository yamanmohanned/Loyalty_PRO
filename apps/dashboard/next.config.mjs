/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship TypeScript source, not a build step.
  transpilePackages: ['@walaa/shared-types', '@walaa/config'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // CLAUDE.md §7.3 — HSTS on the dashboard.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
