const isProd = process.env.VERCEL_ENV === "production" || (process.env.NODE_ENV === "production" && !process.env.VERCEL_ENV);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sealed/shared", "@sealed/defi"],
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  // Apex → www (Vercel also does this at the domain level; this is a fallback).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "sealedsol.xyz" }],
        destination: "https://www.sealedsol.xyz/:path*",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), fs: false, os: false, path: false };
    }
    // Optional native deps pulled in by wallet adapters / ws.
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

export default nextConfig;
